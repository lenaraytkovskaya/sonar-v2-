import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Proxy list for social networks: SOCIAL_PROXY_URLS (comma separated URLs) or, when it is empty,
 * the private file mounted at SOCIAL_PROXY_FILE with one proxy per line, either a URL or the
 * IPRoyal form host:port:user:password. Credentials never leave this function in logs.
 */
export function socialProxyList(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  if (env.SOCIAL_PROXY_URLS?.trim()) return env.SOCIAL_PROXY_URLS;
  let text = '';
  try {
    text = read(env.SOCIAL_PROXY_FILE || '/run/secrets/social-proxies.txt');
  } catch {
    return '';
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (/^https?:\/\//i.test(line)) return line;
      const [host, port, user, ...rest] = line.split(':');
      const password = rest.join(':');
      if (!host || !port) return line;
      return user
        ? `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`
        : `http://${host}:${port}`;
    })
    .join(',');
}
import {
  decryptTelegramSession,
  encryptTelegramSession,
} from './telegram-crypto.js';
import type { SocialNetwork } from './social.js';

export class SocialSendError extends Error {
  constructor(
    public code: 'session_invalid' | 'unavailable' | 'delivery_uncertain',
    public reasonUk: string,
  ) {
    super(reasonUk);
    this.name = 'SocialSendError';
  }
}
export interface SocialSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}
export interface SocialSessionProxy {
  server: string;
  username?: string;
  password?: string;
}
function invalid(): never {
  throw new SocialSendError(
    'session_invalid',
    'Некоректні або застарілі cookies. Експортуйте сесію повторно.',
  );
}
export function normalizeSocialCookies(
  raw: string,
  network: SocialNetwork,
): SocialSessionCookie[] {
  if (typeof raw !== 'string' || raw.length > 1_000_000) invalid();
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (!Array.isArray(values) || !values.length || values.length > 500)
    invalid();
  const seen = new Set<string>();
  return values.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const cookie = value as Record<string, unknown>;
    const {
      name,
      value: content,
      domain,
      path = '/',
      expirationDate,
      expires,
      httpOnly = false,
      secure = false,
      sameSite = 'unspecified',
      session,
    } = cookie;
    if (
      typeof name !== 'string' ||
      !name ||
      /[\p{Cc}\s;,=]/u.test(name) ||
      typeof content !== 'string' ||
      /\p{Cc}/u.test(content) ||
      typeof domain !== 'string' ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      /\p{Cc}/u.test(path) ||
      typeof httpOnly !== 'boolean' ||
      typeof secure !== 'boolean' ||
      (session !== undefined && typeof session !== 'boolean')
    )
      invalid();
    const host = domain.toLowerCase().replace(/^\./, '');
    if (host !== `${network}.com` && !host.endsWith(`.${network}.com`))
      invalid();
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
        host,
      )
    )
      invalid();
    const expiry = session === true ? -1 : (expirationDate ?? expires ?? -1);
    if (
      typeof expiry !== 'number' ||
      !Number.isFinite(expiry) ||
      (expiry !== -1 && expiry <= 0)
    )
      invalid();
    const sites: Record<string, SocialSessionCookie['sameSite']> = {
      strict: 'Strict',
      lax: 'Lax',
      none: 'None',
      no_restriction: 'None',
      unspecified: 'Lax',
    };
    if (
      typeof sameSite !== 'string' ||
      !Object.hasOwn(sites, sameSite.toLowerCase())
    )
      invalid();
    const key = `${name}\n${host}\n${path}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    return {
      name,
      value: content,
      domain: domain.startsWith('.') ? `.${host}` : host,
      path,
      expires: expiry,
      httpOnly,
      secure,
      sameSite: sites[sameSite.toLowerCase()]!,
    };
  });
}
export function socialSessionProxies(
  raw = socialProxyList(),
): SocialSessionProxy[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(part);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        return {
          server: url.origin,
          ...(url.username
            ? { username: decodeURIComponent(url.username) }
            : {}),
          ...(url.password
            ? { password: decodeURIComponent(url.password) }
            : {}),
        };
      } catch {
        throw new SocialSendError(
          'unavailable',
          'Налаштуйте коректний SOCIAL_PROXY_URLS на сервері.',
        );
      }
    });
}
export const socialProxyFingerprint = (proxy: SocialSessionProxy) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        proxy.server,
        proxy.username ?? '',
        proxy.password ?? '',
      ]),
    )
    .digest('hex');
export function encryptSocialCookies(
  raw: string,
  network: SocialNetwork,
  secret: string,
): string {
  return encryptTelegramSession(
    JSON.stringify(normalizeSocialCookies(raw, network)),
    secret,
  );
}
export function resolveSocialSession(
  account: { channel: SocialNetwork; settings: Record<string, unknown> },
  secret = process.env.AUTH_SECRET ?? '',
  proxyUrls = socialProxyList(),
) {
  const settings = account.settings;
  const proxies = socialSessionProxies(proxyUrls);
  const proxy = Number.isInteger(settings.proxyIndex)
    ? proxies[Number(settings.proxyIndex)]
    : undefined;
  if (!proxy || socialProxyFingerprint(proxy) !== settings.proxyFingerprint)
    throw new SocialSendError(
      'session_invalid',
      'Закріплений проксі недоступний або змінений. Виберіть проксі та перевірте сесію повторно.',
    );
  if (typeof settings.cookiesEncrypted !== 'string') invalid();
  try {
    return {
      network: account.channel,
      cookies: normalizeSocialCookies(
        decryptTelegramSession(settings.cookiesEncrypted as string, secret),
        account.channel,
      ),
      proxy,
    };
  } catch {
    return invalid();
  }
}
