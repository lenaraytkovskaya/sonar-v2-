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

// This records an observed browser dispatch, never a server delivery receipt.
export const facebookDispatchReason = 'Відправлено, перевірте в чаті';
export type FacebookDispatchResult = {
  outcome: 'facebook_dispatched_unconfirmed';
  externalMessageId?: string;
  threadId?: string;
  dialogUrl: string;
  observation: {
    inputExactMatch: boolean;
    dispatchPerformed: boolean;
    outgoingBefore: number;
    outgoingAfter: number;
    newOutgoing: boolean;
    observationMs: number;
    lateError:
      | 'none'
      | 'outgoing_changed'
      | 'session'
      | 'rate_limit'
      | 'browser'
      | 'network'
      | 'http_error';
    senderFingerprint?: string;
  };
};

export class SocialSendError extends Error {
  constructor(
    public code:
      'session_invalid' | 'rate_limit' | 'unavailable' | 'delivery_uncertain',
    public reasonUk: string,
  ) {
    super(reasonUk);
    this.name = 'SocialSendError';
  }
}
// Fixed reasons are safe to persist; raw browser errors must never reach the UI/DB.
export const socialSessionCheckReasons = {
  login_required:
    'Потрібен вхід у соцмережу. Увійдіть знову та оновіть cookies.',
  cookies_invalid:
    'Некоректні або застарілі cookies. Експортуйте сесію повторно.',
  captcha: 'Соцмережа вимагає CAPTCHA. Пройдіть перевірку вручну.',
  checkpoint:
    'Соцмережа вимагає підтвердження особи. Пройдіть перевірку вручну.',
  rate_limit:
    'Соцмережа обмежила частоту запитів. Повторіть перевірку пізніше.',
  timeout: 'Час очікування соцмережі вичерпано. Повторіть перевірку пізніше.',
  network: 'Не вдалося з’єднатися із соцмережею. Перевірте мережу та проксі.',
  proxy:
    'Закріплений проксі недоступний або змінений. Перевірте налаштування проксі.',
  browser: 'Не вдалося запустити або використати браузер. Повторіть перевірку.',
  unknown_auth: 'Сесію не підтверджено. Перевірте вхід у соцмережу вручну.',
} as const;
export type SocialSessionCheckReason = keyof typeof socialSessionCheckReasons;
export type SocialSessionCheckDiagnostic = {
  version: 1;
  stage: 'navigation' | 'http' | 'auth';
  urlKind: 'home' | 'feed' | 'login' | 'checkpoint' | 'captcha' | 'other';
  navigationHttpStatus: number | null;
  errorKind: 'timeout' | 'unconfirmed';
  visible: {
    legacyAuth: number;
    semanticAuth: number;
    captcha: number;
    checkpoint: number;
    login: number;
  };
};
/** Rebuild from fixed keys; never persist arbitrary browser/callback properties. */
export function safeSocialSessionDiagnostic(
  value: unknown,
): SocialSessionCheckDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const d = value as SocialSessionCheckDiagnostic;
  if (
    d.version !== 1 ||
    !['navigation', 'http', 'auth'].includes(d.stage) ||
    !['home', 'feed', 'login', 'checkpoint', 'captcha', 'other'].includes(
      d.urlKind,
    ) ||
    !['timeout', 'unconfirmed'].includes(d.errorKind) ||
    !d.visible ||
    (d.navigationHttpStatus !== null &&
      (!Number.isInteger(d.navigationHttpStatus) ||
        d.navigationHttpStatus < 100 ||
        d.navigationHttpStatus > 599))
  )
    return;
  const visible = {} as SocialSessionCheckDiagnostic['visible'];
  for (const key of [
    'legacyAuth',
    'semanticAuth',
    'captcha',
    'checkpoint',
    'login',
  ] as const) {
    const count = d.visible[key];
    if (!Number.isSafeInteger(count) || count < 0) return;
    visible[key] = Math.min(count, 2);
  }
  return {
    version: 1,
    stage: d.stage,
    urlKind: d.urlKind,
    navigationHttpStatus: d.navigationHttpStatus,
    errorKind: d.errorKind,
    visible,
  };
}
export class SocialSessionCheckError extends SocialSendError {
  diagnostic?: SocialSessionCheckDiagnostic;
  errorKind?: 'timeout' | 'unconfirmed';
  constructor(public reason: SocialSessionCheckReason) {
    super(
      reason === 'rate_limit'
        ? 'rate_limit'
        : [
              'login_required',
              'cookies_invalid',
              'captcha',
              'checkpoint',
              'unknown_auth',
              'proxy',
            ].includes(reason)
          ? 'session_invalid'
          : 'unavailable',
      socialSessionCheckReasons[reason],
    );
  }
}
export function socialSessionCheckReason(
  error: unknown,
  fallback: SocialSessionCheckReason = 'unknown_auth',
): SocialSessionCheckReason {
  if (error instanceof SocialSessionCheckError) return error.reason;
  if (!(error instanceof Error)) return fallback;
  if (error.name === 'TimeoutError') return 'timeout';
  if (
    /net::ERR_(?:PROXY|TUNNEL)|proxy authentication|\b407\b/i.test(
      error.message,
    )
  )
    return 'proxy';
  if (
    /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(error.message)
  )
    return 'network';
  return fallback;
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
  throw new SocialSessionCheckError('cookies_invalid');
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
      session,
    } = cookie;
    const sameSite = cookie.sameSite ?? 'unspecified';
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
/** Original list indices belong to accounts; never filter or reorder that list. */
export function socialReservedProxyIndex(
  value: unknown,
  count: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= count
  )
    throw new Error(
      'Налаштуйте резервний проксі акаунтів у БД (social.account_proxy_index).',
    );
  return value;
}
export function socialAnonymousProxies<T extends SocialSessionProxy>(
  proxies: T[],
  reservedIndex: unknown,
): T[] {
  const index = socialReservedProxyIndex(reservedIndex, proxies.length);
  // Credentials and protocol variations must not reintroduce the reserved endpoint.
  const endpoint = (proxy: SocialSessionProxy) => {
    const url = new URL(proxy.server);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  };
  const reserved = endpoint(proxies[index]!);
  return proxies.filter((proxy) => endpoint(proxy) !== reserved);
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
    throw new SocialSessionCheckError('proxy');
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
