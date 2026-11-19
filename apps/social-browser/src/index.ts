import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  createServer as createTcpServer,
  connect as connectTcp,
  type Server as TcpServer,
} from 'node:net';
import { chromium, type BrowserContext } from 'playwright';

type Profile = {
  context: BrowserContext;
  port: number;
  connectPort: number;
  instance: string;
  lastUsedAt: number;
  busy: boolean;
  busyAt: number | null;
  forwarder: TcpServer;
};
const profiles = new Map<string, Profile>();
const firstPort = Number(process.env.SOCIAL_BROWSER_CDP_PORT ?? 9300);
const portRange = Number(process.env.SOCIAL_BROWSER_CDP_PORTS ?? 100);
const firstConnectPort = Number(
  process.env.SOCIAL_BROWSER_CONNECT_PORT ?? 9400,
);
const key = process.env.SOCIAL_BROWSER_KEY?.trim() ?? '';
const root = process.env.SOCIAL_BROWSER_DATA ?? '/data/profiles';
let idleTimeoutMs = Number(process.env.SOCIAL_BROWSER_IDLE_MS ?? 1800000);
const networks = new Set(['facebook', 'instagram', 'linkedin']);
let starts = Promise.resolve();
const home: Record<string, string> = {
  facebook: 'https://www.facebook.com/login/',
  instagram: 'https://www.instagram.com/accounts/login/',
  linkedin: 'https://www.linkedin.com/login',
};
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const json = (
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
};
async function body(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 8192) throw new Error('body_too_large');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}
function freePort() {
  const used = new Set([...profiles.values()].map((profile) => profile.port));
  for (let offset = 0; offset < portRange; offset++) {
    const port = firstPort + offset;
    if (!used.has(port)) return port;
  }
  return undefined;
}
function freeConnectPort() {
  const used = new Set(
    [...profiles.values()].map((profile) => profile.connectPort),
  );
  for (let offset = 0; offset < portRange; offset++) {
    const port = firstConnectPort + offset;
    if (!used.has(port)) return port;
  }
  return undefined;
}
async function forwardPort(connectPort: number, browserPort: number) {
  const server = createTcpServer((socket) => {
    const upstream = connectTcp(browserPort, '127.0.0.1');
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.pipe(socket);
    let head = Buffer.alloc(0);
    let forwarded = false;
    upstream.once('connect', () => {
      socket.on('data', (chunk) => {
        if (forwarded) {
          upstream.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        if (head.length > 65536) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        const boundary = head.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const requestHead = head.subarray(0, boundary).toString('latin1');
        const rewritten = requestHead.replace(
          /^host:[^\r\n]*$/im,
          `Host: localhost:${browserPort}`,
        );
        upstream.write(rewritten + '\r\n\r\n');
        upstream.write(head.subarray(boundary + 4));
        head = Buffer.alloc(0);
        forwarded = true;
      });
      socket.resume();
    });
    socket.pause();
    socket.on('end', () => upstream.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(connectPort, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
async function startProfile(input: Record<string, unknown>) {
  const id = input.id;
  const network = input.network;
  if (!safeId(id) || typeof network !== 'string' || !networks.has(network))
    throw new Error('invalid_profile');
  const configuredIdle = Number(input.idleMs);
  if (
    Number.isInteger(configuredIdle) &&
    configuredIdle >= 60000 &&
    configuredIdle <= 86400000
  )
    idleTimeoutMs = configuredIdle;
  const existing = profiles.get(id);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const maximum = Number(input.maxProfiles);
  if (!Number.isInteger(maximum) || maximum < 1 || profiles.size >= maximum)
    throw new Error('profile_limit');
  const port = freePort();
  const connectPort = freeConnectPort();
  if (!port || !connectPort) throw new Error('profile_limit');
  const proxyInput = input.proxy as Record<string, unknown> | undefined;
  let proxy:
    { server: string; username?: string; password?: string } | undefined;
  if (proxyInput) {
    if (
      typeof proxyInput.server !== 'string' ||
      !/^https?:\/\//.test(proxyInput.server) ||
      (proxyInput.username !== undefined &&
        typeof proxyInput.username !== 'string') ||
      (proxyInput.password !== undefined &&
        typeof proxyInput.password !== 'string')
    )
      throw new Error('invalid_proxy');
    proxy = {
      server: proxyInput.server,
      ...(proxyInput.username ? { username: proxyInput.username } : {}),
      ...(proxyInput.password ? { password: proxyInput.password } : {}),
    };
  }
  const path = `${root}/${id}`;
  await mkdir(path, { recursive: true });
  const context = await chromium.launchPersistentContext(path, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    ...(proxy ? { proxy } : {}),
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=0.0.0.0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15000);
  await page
    .goto(home[network]!, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(() => {});
  let forwarder: TcpServer;
  try {
    forwarder = await forwardPort(connectPort, port);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  const profile = {
    context,
    port,
    connectPort,
    instance: randomUUID(),
    lastUsedAt: Date.now(),
    busy: false,
    busyAt: null,
    forwarder,
  };
  profiles.set(id, profile);
  return profile;
}
function ensureProfile(input: Record<string, unknown>) {
  const pending = starts.then(() => startProfile(input));
  starts = pending.then(
    () => {},
    () => {},
  );
  return pending;
}
const server = createServer(async (request, response) => {
  if (request.url === '/health') return json(response, 200, { ready: true });
  if (!key) return json(response, 503, { error: 'unavailable' });
  if (request.headers.authorization !== `Bearer ${key}`)
    return json(response, 401, { error: 'unauthorized' });
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/profiles' && request.method === 'POST') {
      const profile = await ensureProfile(await body(request));
      return json(response, 200, {
        port: profile.connectPort,
        instance: profile.instance,
      });
    }
    const match =
      /^\/profiles\/([0-9a-f-]{36})(?:\/(screen|action|close|lock|unlock))?$/i.exec(
        url.pathname,
      );
    if (!match) return json(response, 404, { error: 'not_found' });
    const id = match[1]!;
    const action = match[2];
    const profile = profiles.get(id);
    if (!profile) return json(response, 404, { error: 'profile_not_running' });
    profile.lastUsedAt = Date.now();
    if (action === 'lock' && request.method === 'POST') {
      if (profile.busy) return json(response, 409, { error: 'profile_busy' });
      profile.busy = true;
      profile.busyAt = Date.now();
      return json(response, 200, { locked: true });
    }
    if (action === 'unlock' && request.method === 'POST') {
      profile.busy = false;
      profile.busyAt = null;
      return json(response, 200, { unlocked: true });
    }
    if (action === 'close' && request.method === 'POST') {
      await profile.context.close();
      profile.forwarder.close();
      profiles.delete(id);
      return json(response, 200, { closed: true });
    }
    if (action === 'screen' && request.method === 'GET') {
      const page = profile.context.pages()[0];
      if (!page) return json(response, 503, { error: 'screen_unavailable' });
      const image = await page.screenshot({
        type: 'jpeg',
        quality: 65,
        timeout: 5000,
      });
      response.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      });
      return response.end(image);
    }
    if (action === 'action' && request.method === 'POST') {
      if (profile.busy) return json(response, 409, { error: 'profile_busy' });
      const input = await body(request);
      const page =
        profile.context.pages()[0] ?? (await profile.context.newPage());
      if (input.navigate !== undefined) {
        if (typeof input.navigate !== 'string')
          return json(response, 400, { error: 'invalid_action' });
        const target = new URL(input.navigate);
        if (
          target.protocol !== 'https:' ||
          ![
            'facebook.com',
            'instagram.com',
            'linkedin.com',
            'example.com',
          ].some(
            (host) =>
              target.hostname === host || target.hostname.endsWith(`.${host}`),
          )
        )
          return json(response, 400, { error: 'invalid_action' });
        await page.goto(target.href, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      }
      if (Number.isFinite(input.x) && Number.isFinite(input.y))
        await page.mouse.click(Number(input.x), Number(input.y));
      if (typeof input.text === 'string' && input.text.length <= 4096)
        await page.keyboard.type(input.text);
      if (
        typeof input.key === 'string' &&
        ['Enter', 'Tab', 'Backspace', 'Escape'].includes(input.key)
      )
        await page.keyboard.press(input.key);
      return json(response, 200, { accepted: true });
    }
    return json(response, 405, { error: 'method_not_allowed' });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status =
      code === 'profile_limit'
        ? 429
        : code === 'invalid_profile' || code === 'invalid_proxy'
          ? 400
          : 502;
    return json(response, status, {
      error: [
        'profile_limit',
        'invalid_profile',
        'invalid_proxy',
        'body_too_large',
      ].includes(code)
        ? code
        : 'browser_unavailable',
    });
  }
});
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
setInterval(() => {
  for (const [id, profile] of profiles) {
    if (
      profile.busy &&
      profile.busyAt &&
      Date.now() - profile.busyAt >= 1800000
    ) {
      profile.busy = false;
      profile.busyAt = null;
    }
    if (!profile.busy && Date.now() - profile.lastUsedAt >= idleTimeoutMs) {
      profile.context.close().catch(() => {});
      profile.forwarder.close();
      profiles.delete(id);
    }
  }
}, 60000).unref();
const close = async () => {
  await Promise.allSettled(
    [...profiles.values()].map(({ context, forwarder }) => {
      forwarder.close();
      return context.close();
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
