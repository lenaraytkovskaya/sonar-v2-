import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accountDatabase, readMessages, run } from './database.js';
import { createSend, type SendInput } from './send.js';

const data = process.env.VIBER_DATA_DIR || '/data';
const version = process.env.VIBER_DESKTOP_VERSION || '29.4.0.7';
const key = process.env.VIBER_BRIDGE_KEY;
if (!key) throw Error('VIBER_BRIDGE_KEY is required');
await mkdir(data, { recursive: true, mode: 0o700 });
const xvfb = spawn(
  'Xvfb',
  [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
  { stdio: 'inherit' },
);
await delay(1500);
const wm = spawn('openbox', [], { stdio: 'ignore' });
const viber = spawn('/opt/viber/Viber', [], { stdio: 'inherit' });
let processError = false;
for (const child of [xvfb, wm, viber])
  child.on('error', () => {
    processError = true;
  });
const screen = async () =>
  (
    await run('import', ['-window', 'root', '-quality', '85', 'jpeg:-'], {
      encoding: 'buffer',
      timeout: 10000,
      maxBuffer: 3 * 1024 * 1024,
    })
  ).stdout;
const database = () => accountDatabase(join(data, '.ViberPC'));
const messages = async (since: Date) => {
  const account = await database();
  if (!account) throw Error('needs_activation');
  return readMessages(account.path, since);
};
const send = createSend(join(data, 'receipts'), {
  messages,
  screen,
  wait: () => delay(1000),
  async open(url, to) {
    // The official .desktop entry is Exec=/opt/viber/Viber %u. A second instance
    // forwards its URI to the running single-instance Qt application.
    await run('/opt/viber/Viber', [url], { timeout: 10000 });
    await delay(2000);
    const { stdout } = await run(
      'xdotool',
      ['search', '--onlyvisible', '--class', 'Viber'],
      { timeout: 3000 },
    );
    const window = stdout.trim().split('\n').at(-1);
    if (!window || !/^\d+$/.test(window)) throw Error('chat_window_missing');
    await run('xdotool', ['windowsize', window, '1280', '900']);
    await run('xdotool', ['windowmove', window, '0', '0']);
    await run('xdotool', ['windowactivate', '--sync', window]);
    // Only a visibly verified numeric chat header permits pressing Enter.
    // Named contacts or a changed layout fail closed and retain an uncertain receipt.
    const crop = join(data, 'chat-header.png');
    await run('import', ['-window', window, '-crop', '900x110+380+0', crop]);
    const { stdout: header } = await run(
      'tesseract',
      [crop, 'stdout', '--psm', '11'],
      { timeout: 10000 },
    );
    if (!header.replace(/[^\d]/g, '').includes(to.slice(1)))
      throw Error('recipient_not_verified');
    // Clipboard paste preserves multiline text without producing Enter events.
    // Verify the exact composer selection before dispatching the message.
    const text = new URL(url).searchParams.get('draft')!;
    const draftFile = join(data, 'draft.txt');
    await writeFile(draftFile, text, { mode: 0o600 });
    await run('xdotool', [
      'mousemove',
      '--window',
      window,
      '800',
      '835',
      'click',
      '1',
      'key',
      '--clearmodifiers',
      'ctrl+a',
    ]);
    await run('xclip', ['-selection', 'clipboard', '-i', draftFile], {
      timeout: 3000,
    });
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
    await delay(200);
    // Copy must replace a fresh sentinel; otherwise a failed Ctrl+C could
    // leave our original clipboard value and falsely verify an empty composer.
    await writeFile(draftFile, randomUUID(), { mode: 0o600 });
    await run('xclip', ['-selection', 'clipboard', '-i', draftFile], {
      timeout: 3000,
    });
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a', 'ctrl+c']);
    await delay(200);
    const { stdout: copied } = await run(
      'xclip',
      ['-selection', 'clipboard', '-o'],
      { timeout: 3000 },
    );
    if (copied !== text) throw Error('draft_not_verified');
    await run('xdotool', ['key', '--clearmodifiers', 'Right']);
  },
  async enter() {
    await run('xdotool', ['key', '--clearmodifiers', 'Return']);
  },
});

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const authorization =
    req.headers.authorization?.replace(/^Bearer /, '') ||
    req.headers['x-api-key'];
  const supplied = Buffer.from(
    typeof authorization === 'string' ? authorization : '',
  );
  const secret = Buffer.from(key);
  if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url || '/', 'http://bridge');
  const json = (code: number, value: unknown) => {
    res
      .writeHead(code, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(value));
  };
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      if (
        processError ||
        viber.exitCode !== null ||
        viber.signalCode !== null ||
        xvfb.exitCode !== null ||
        xvfb.signalCode !== null
      )
        return json(200, { state: 'not_running', version });
      const account = await database();
      if (!account) return json(200, { state: 'needs_activation', version });
      try {
        await readMessages(account.path, new Date());
      } catch {
        return json(200, {
          state: 'error',
          number: account.number,
          version,
          reason: 'database_unreadable_or_schema_changed',
        });
      }
      return json(200, { state: 'ready', number: account.number, version });
    }
    if (req.method === 'GET' && url.pathname === '/screen') {
      const bytes = url.searchParams.has('lastFailure')
        ? await readFile(join(data, 'receipts', 'last-failure.jpg'))
        : await screen();
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(bytes);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/inbound') {
      const since = new Date(url.searchParams.get('since') || '');
      return json(
        200,
        (await messages(since))
          .filter((message) => !message.outgoing)
          .map((message) => ({
            from: message.from,
            text: message.text,
            at: message.at,
            providerMessageId: message.providerMessageId,
            threadId: message.threadId,
          })),
      );
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) {
          json(413, { error: 'body_too_large' });
          req.destroy();
          return;
        }
      }
      return json(200, await send(JSON.parse(raw) as SendInput));
    }
    json(404, { error: 'not_found' });
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        'invalid_send',
        'invalid_since',
        'idempotency_conflict',
        'needs_activation',
      ].includes(error.message)
        ? error.message
        : 'bridge_operation_failed';
    json(
      code.startsWith('invalid')
        ? 400
        : code === 'idempotency_conflict'
          ? 409
          : 503,
      { error: code },
    );
  }
});
server.requestTimeout = 60000;
server.listen(3000, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.close();
    for (const child of [viber, wm, xvfb]) child.kill('SIGTERM');
  });
