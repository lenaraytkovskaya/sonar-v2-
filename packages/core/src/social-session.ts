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
  action_blocked:
    'Соцмережа заблокувала дії акаунта. Перевірте обмеження вручну.',
  rate_limit:
    'Соцмережа обмежила частоту запитів. Повторіть перевірку пізніше.',
  timeout: 'Час очікування соцмережі вичерпано. Повторіть перевірку пізніше.',
  network: 'Не вдалося з’єднатися із соцмережею. Перевірте мережу та проксі.',
  proxy:
    'Закріплений проксі недоступний або змінений. Перевірте налаштування проксі.',
  browser: 'Не вдалося запустити або використати браузер. Повторіть перевірку.',
  unknown_auth: 'Сесію не підтверджено. Перевірте вхід у соцмережу вручну.',
} as const;
export {
  socialActionBlockedPattern,
  detectSocialActionBlocked,
} from './social.js';
export type SocialSessionCheckReason = keyof typeof socialSessionCheckReasons;
export type SocialActorFieldKind =
  'missing' | 'null' | 'digit_string' | 'object' | 'other';
export type SocialActorFields = Record<
  'directThread' | 'viewer' | 'viewerId' | 'mailboxId' | 'threadViewerId',
  SocialActorFieldKind
>;
export type SocialSessionCheckDiagnostic = {
  version: 1;
  stage:
    | 'navigation'
    | 'http'
    | 'auth'
    | 'restore'
    | 'identity'
    | 'capture_auth'
    | 'actor'
    | 'persist';
  urlKind:
    | 'home'
    | 'feed'
    | 'login'
    | 'checkpoint'
    | 'captcha'
    | 'other'
    | 'inbox'
    | 'requests'
    | 'thread';
  navigationHttpStatus: number | null;
  errorKind: 'timeout' | 'unconfirmed';
  /** FB has no semantic auth implementation; its zero counter is not negative evidence. */
  semanticAuthImplemented?: false;
  page?: {
    lang: 'en' | 'uk' | 'ru' | 'other' | 'missing';
    readyState: 'loading' | 'interactive' | 'complete';
    bodyRendered: boolean;
    bodyTextLength: 'empty' | '1_99' | '100_999' | '1000_plus';
    scanTruncated: boolean;
    visible: Record<
      | 'busy'
      | 'progress'
      | 'dialog'
      | 'form'
      | 'password'
      | 'navigation'
      | 'banner'
      | 'main',
      number
    >;
    names: Record<
      | 'home'
      | 'menu'
      | 'account'
      | 'your_profile'
      | 'allow_all_cookies'
      | 'decline_optional_cookies',
      number
    >;
    hrefs: Record<
      'home' | 'profile' | 'messages' | 'me' | 'login' | 'other',
      number
    >;
  };
  visible: {
    legacyAuth: number;
    semanticAuth: number;
    captcha: number;
    checkpoint: number;
    login: number;
  };
  history?: {
    threadList: number;
    messageRegions: number;
    messageNodes: number;
    pinRestore: number;
    restoreConfirmation: number;
    historyMissing: number;
  };
  capture?: {
    received: number;
    parsed: number;
    verified: number;
    persisted: number;
    httpStatus: number | null;
  };
  actor?: {
    reason:
      | 'mailbox_missing'
      | 'initial_actors_empty'
      | 'mailbox_changed'
      | 'actor_shape_unsupported'
      | 'viewer_mismatch'
      | 'actor_mailbox_mismatch';
    hasPreviousMailbox: boolean;
    hasMailbox: boolean;
    hasActors: boolean;
    emptyEdges: boolean;
    allViewersMatchExpected: boolean;
    anyViewerMatchesExpected: boolean;
    anyActorMailboxMatchesExpected: boolean;
    responseMailboxMatchesExpected: boolean;
    allActorMailboxesMatchResponse: boolean;
    fields?: SocialActorFields;
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
    ![
      'navigation',
      'http',
      'auth',
      'restore',
      'identity',
      'capture_auth',
      'actor',
      'persist',
    ].includes(d.stage) ||
    ![
      'home',
      'feed',
      'login',
      'checkpoint',
      'captcha',
      'other',
      'inbox',
      'requests',
      'thread',
    ].includes(d.urlKind) ||
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
  let capture: SocialSessionCheckDiagnostic['capture'];
  if (
    d.semanticAuthImplemented !== undefined &&
    d.semanticAuthImplemented !== false
  )
    return;
  let page: SocialSessionCheckDiagnostic['page'];
  if (d.page !== undefined) {
    const p = d.page;
    if (
      !p ||
      !['en', 'uk', 'ru', 'other', 'missing'].includes(p.lang) ||
      !['loading', 'interactive', 'complete'].includes(p.readyState) ||
      !['empty', '1_99', '100_999', '1000_plus'].includes(p.bodyTextLength) ||
      typeof p.bodyRendered !== 'boolean' ||
      typeof p.scanTruncated !== 'boolean'
    )
      return;
    const counts = <K extends string>(source: Record<K, number>, keys: K[]) => {
      if (!source || typeof source !== 'object') return;
      const result = {} as Record<K, number>;
      for (const key of keys) {
        if (!Number.isSafeInteger(source[key]) || source[key] < 0) return;
        result[key] = Math.min(source[key], 2);
      }
      return result;
    };
    const visible = counts(p.visible, [
      'busy',
      'progress',
      'dialog',
      'form',
      'password',
      'navigation',
      'banner',
      'main',
    ]);
    const names = counts(p.names, [
      'home',
      'menu',
      'account',
      'your_profile',
      'allow_all_cookies',
      'decline_optional_cookies',
    ]);
    const hrefs = counts(p.hrefs, [
      'home',
      'profile',
      'messages',
      'me',
      'login',
      'other',
    ]);
    if (!visible || !names || !hrefs) return;
    page = {
      lang: p.lang,
      readyState: p.readyState,
      bodyRendered: p.bodyRendered,
      bodyTextLength: p.bodyTextLength,
      scanTruncated: p.scanTruncated,
      visible,
      names,
      hrefs,
    };
  }
  let history: SocialSessionCheckDiagnostic['history'];
  if (d.history !== undefined) {
    if (!d.history || typeof d.history !== 'object') return;
    history = {} as NonNullable<SocialSessionCheckDiagnostic['history']>;
    for (const key of [
      'threadList',
      'messageRegions',
      'messageNodes',
      'pinRestore',
      'restoreConfirmation',
      'historyMissing',
    ] as const) {
      const count = d.history[key];
      if (!Number.isSafeInteger(count) || count < 0) return;
      history[key] = Math.min(count, 2);
    }
  }
  if (d.capture) {
    const { httpStatus } = d.capture;
    if (
      httpStatus !== null &&
      (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
    )
      return;
    capture = { received: 0, parsed: 0, verified: 0, persisted: 0, httpStatus };
    for (const key of [
      'received',
      'parsed',
      'verified',
      'persisted',
    ] as const) {
      const count = d.capture[key];
      if (!Number.isSafeInteger(count) || count < 0) return;
      capture[key] = Math.min(count, 2);
    }
  }
  let actor: SocialSessionCheckDiagnostic['actor'];
  if (d.actor !== undefined) {
    if (
      !d.actor ||
      ![
        'mailbox_missing',
        'initial_actors_empty',
        'mailbox_changed',
        'actor_shape_unsupported',
        'viewer_mismatch',
        'actor_mailbox_mismatch',
      ].includes(d.actor.reason)
    )
      return;
    const facts = {} as Omit<
      NonNullable<SocialSessionCheckDiagnostic['actor']>,
      'reason'
    >;
    for (const key of [
      'hasPreviousMailbox',
      'hasMailbox',
      'hasActors',
      'emptyEdges',
      'allViewersMatchExpected',
      'anyViewerMatchesExpected',
      'anyActorMailboxMatchesExpected',
      'responseMailboxMatchesExpected',
      'allActorMailboxesMatchResponse',
    ] as const) {
      if (typeof d.actor[key] !== 'boolean') return;
      facts[key] = d.actor[key];
    }
    actor = { reason: d.actor.reason, ...facts };
    if (d.actor.fields !== undefined) {
      const fields = {} as SocialActorFields;
      for (const key of [
        'directThread',
        'viewer',
        'viewerId',
        'mailboxId',
        'threadViewerId',
      ] as const) {
        const kind = d.actor.fields?.[key];
        if (
          !['missing', 'null', 'digit_string', 'object', 'other'].includes(
            kind ?? '',
          )
        )
          return;
        fields[key] = kind!;
      }
      actor.fields = fields;
    }
  }
  return {
    version: 1,
    stage: d.stage,
    urlKind: d.urlKind,
    navigationHttpStatus: d.navigationHttpStatus,
    errorKind: d.errorKind,
    ...(d.semanticAuthImplemented === false
      ? { semanticAuthImplemented: false }
      : {}),
    ...(page ? { page } : {}),
    visible,
    ...(history ? { history } : {}),
    ...(capture ? { capture } : {}),
    ...(actor ? { actor } : {}),
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
              'action_blocked',
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
  partitionKey?: string;
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
  allowOtherDomains = false,
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
      (session !== undefined && typeof session !== 'boolean') ||
      (cookie.partitionKey !== undefined &&
        (typeof cookie.partitionKey !== 'string' ||
          cookie.partitionKey.length > 2048))
    )
      invalid();
    const host = domain.toLowerCase().replace(/^\./, '');
    if (
      !allowOtherDomains &&
      host !== `${network}.com` &&
      !host.endsWith(`.${network}.com`)
    )
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
      ...(typeof cookie.partitionKey === 'string'
        ? { partitionKey: cookie.partitionKey }
        : {}),
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
  accountProxies: SocialSessionProxy[] = [],
): T[] {
  const reservedProxies = Array.isArray(reservedIndex)
    ? (reservedIndex as SocialSessionProxy[])
    : [
        proxies[socialReservedProxyIndex(reservedIndex, proxies.length)]!,
        ...accountProxies,
      ];
  // Credentials and protocol variations must not reintroduce the reserved endpoint.
  const endpoint = (proxy: SocialSessionProxy) => {
    const url = new URL(proxy.server);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  };
  const reserved = new Set(reservedProxies.map(endpoint));
  return proxies.filter((proxy) => !reserved.has(endpoint(proxy)));
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
export interface SocialStorageState {
  cookies: SocialSessionCookie[];
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
  }[];
}
export interface SocialDevice {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  deviceScaleFactor: number;
}
export function generateSocialDevice(
  _network: SocialNetwork,
  browserVersion = '',
): SocialDevice {
  return {
    userAgent: browserVersion
      ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`
      : '',
    viewport: { width: 1366, height: 768 },
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    deviceScaleFactor: 1,
  };
}
export function normalizeSocialStorageState(
  raw: string,
  network: SocialNetwork,
): SocialStorageState {
  if (typeof raw !== 'string' || raw.length > 5_000_000) invalid();
  let state: SocialStorageState;
  try {
    state = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (Array.isArray(state))
    return { cookies: normalizeSocialCookies(raw, network), origins: [] };
  if (!state || !Array.isArray(state.origins) || state.origins.length > 100)
    invalid();
  const cookies = normalizeSocialCookies(
    JSON.stringify(state.cookies),
    network,
    true,
  );
  const seen = new Set<string>();
  const origins = state.origins.map((entry) => {
    if (
      !entry ||
      typeof entry.origin !== 'string' ||
      !Array.isArray(entry.localStorage) ||
      entry.localStorage.length > 5000
    )
      invalid();
    let url: URL;
    try {
      url = new URL(entry.origin);
    } catch {
      return invalid();
    }
    if (
      url.origin !== entry.origin ||
      url.protocol !== 'https:' ||
      seen.has(url.origin)
    )
      invalid();
    seen.add(url.origin);
    const names = new Set<string>();
    return {
      origin: url.origin,
      localStorage: entry.localStorage.map((item) => {
        if (
          !item ||
          typeof item.name !== 'string' ||
          typeof item.value !== 'string' ||
          names.has(item.name)
        )
          invalid();
        names.add(item.name);
        return { name: item.name, value: item.value };
      }),
    };
  });
  return { cookies, origins };
}
export function encryptSocialStorageState(
  raw: string,
  network: SocialNetwork,
  secret: string,
): string {
  return encryptTelegramSession(
    JSON.stringify(normalizeSocialStorageState(raw, network)),
    secret,
  );
}
export function normalizeSocialProxy(raw: string): SocialSessionProxy {
  const values = socialSessionProxies(raw);
  if (values.length !== 1) throw new SocialSessionCheckError('proxy');
  return values[0]!;
}
export function encryptSocialProxy(raw: string, secret: string): string {
  normalizeSocialProxy(raw);
  return encryptTelegramSession(raw, secret);
}
export function decryptSocialProxy(
  encrypted: string,
  secret: string,
): SocialSessionProxy {
  return normalizeSocialProxy(decryptTelegramSession(encrypted, secret));
}
export type ResolvedSocialSession = {
  network: SocialNetwork;
  cookies: SocialSessionCookie[];
  storageState?: SocialStorageState;
  proxy: SocialSessionProxy;
  device?: SocialDevice;
  persistStorageState?: (
    state: SocialStorageState,
    device?: SocialDevice,
  ) => Promise<void>;
  persistDevice?: (device: SocialDevice) => Promise<void>;
};
export function resolveSocialSession(
  account: { channel: SocialNetwork; settings: Record<string, unknown> },
  secret = process.env.AUTH_SECRET ?? '',
  proxyUrls = socialProxyList(),
  allowLoggedOut = false,
): ResolvedSocialSession {
  const settings = account.settings;
  let proxy: SocialSessionProxy | undefined;
  if (typeof settings.ownProxyEncrypted === 'string') {
    try {
      proxy = normalizeSocialProxy(
        decryptTelegramSession(settings.ownProxyEncrypted, secret),
      );
    } catch {
      throw new SocialSessionCheckError('proxy');
    }
  } else {
    const proxies = socialSessionProxies(proxyUrls);
    proxy = Number.isInteger(settings.proxyIndex)
      ? proxies[Number(settings.proxyIndex)]
      : undefined;
    if (!proxy || socialProxyFingerprint(proxy) !== settings.proxyFingerprint)
      throw new SocialSessionCheckError('proxy');
  }
  try {
    const encrypted =
      settings.storageStateEncrypted ?? settings.cookiesEncrypted;
    if (typeof encrypted !== 'string') invalid();
    const storageState = normalizeSocialStorageState(
      decryptTelegramSession(encrypted, secret),
      account.channel,
    );
    return {
      network: account.channel,
      cookies: storageState.cookies,
      storageState,
      proxy,
      device:
        (settings.device as SocialDevice | undefined) ??
        generateSocialDevice(account.channel),
    };
  } catch {
    if (allowLoggedOut)
      return {
        network: account.channel,
        cookies: [],
        storageState: { cookies: [], origins: [] },
        proxy,
        device:
          (settings.device as SocialDevice | undefined) ??
          generateSocialDevice(account.channel),
      };
    return invalid();
  }
}
