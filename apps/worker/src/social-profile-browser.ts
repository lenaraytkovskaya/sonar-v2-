import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { SocialSessionAccount } from './social-send-browser.js';
import type { SocialBrowserSession } from './social-send-browser.js';

const clients = new Map<
  string,
  { instance: string; browser: Promise<Browser> }
>();
function serviceUrl() {
  const url = process.env.SOCIAL_BROWSER_URL;
  const key = process.env.SOCIAL_BROWSER_KEY;
  if (!url || !key) throw new Error('social_browser_unavailable');
  return { url, key };
}
async function settings() {
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select key,value from settings where key in ('social.browser.max_profiles','social.browser.idle_ms')",
  );
  const values = Object.fromEntries(
    rows.map((row) => [row.key, Number(row.value)]),
  );
  const maxProfiles = values['social.browser.max_profiles'] ?? 3;
  const idleMs = values['social.browser.idle_ms'] ?? 1800000;
  if (
    !Number.isInteger(maxProfiles) ||
    maxProfiles < 1 ||
    maxProfiles > 100 ||
    !Number.isInteger(idleMs) ||
    idleMs < 60000 ||
    idleMs > 86400000
  )
    throw new Error('social_browser_settings_invalid');
  return { maxProfiles, idleMs };
}
export async function connectSocialProfile(
  account: SocialSessionAccount,
  session: SocialBrowserSession,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const { url, key } = serviceUrl();
  const { maxProfiles, idleMs } = await settings();
  const response = await fetch(new URL('/profiles', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: account.id,
      network: account.channel,
      proxy: session.proxy,
      maxProfiles,
      idleMs,
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) throw new Error('social_browser_unavailable');
  const result = (await response.json()) as {
    port?: number;
    instance?: string;
  };
  if (
    !Number.isSafeInteger(result.port) ||
    result.port! < 9400 ||
    result.port! > 9499 ||
    typeof result.instance !== 'string'
  )
    throw new Error('social_browser_unavailable');
  const browserService = new URL(url);
  const endpointResponse = await fetch(
    `${browserService.protocol}//${browserService.hostname}:${result.port}/json/version`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!endpointResponse.ok) throw new Error('social_browser_unavailable');
  const endpointData = (await endpointResponse.json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (typeof endpointData.webSocketDebuggerUrl !== 'string')
    throw new Error('social_browser_unavailable');
  const endpoint = new URL(endpointData.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    !/^93\d\d$/.test(endpoint.port) ||
    !endpoint.pathname.startsWith('/devtools/browser/')
  )
    throw new Error('social_browser_unavailable');
  endpoint.hostname = browserService.hostname;
  endpoint.port = String(result.port);
  let client = clients.get(account.id);
  if (!client || client.instance !== result.instance) {
    const browser = chromium.connectOverCDP(endpoint.href);
    client = { instance: result.instance, browser };
    clients.set(account.id, client);
    browser.catch(() => {
      if (clients.get(account.id) === client) clients.delete(account.id);
    });
  }
  try {
    const browser = await client.browser;
    const context = browser.contexts()[0];
    if (!context) throw new Error('social_browser_unavailable');
    return { browser, context };
  } catch {
    clients.delete(account.id);
    throw new Error('social_browser_unavailable');
  }
}
export async function lockSocialProfile(
  accountId: string,
): Promise<() => Promise<void>> {
  const { url, key } = serviceUrl();
  const response = await fetch(new URL(`/profiles/${accountId}/lock`, url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('social_browser_profile_busy');
  return async () => {
    await fetch(new URL(`/profiles/${accountId}/unlock`, url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  };
}
