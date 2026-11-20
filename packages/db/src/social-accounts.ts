import { randomUUID } from 'node:crypto';
import {
  recordHealthEvent,
  enableAccountHealth,
  resumePausedSends,
} from './account-health.js';
import { queueAutomaticSocialRelogin } from './social-login.js';
export {
  saveSocialCredentials,
  queueSocialCredentialLogin,
  submitSocialLoginCode,
  withSocialCredentialLogin,
  reconcileSocialCredentialLogins,
} from './social-login.js';
import type { PoolClient } from 'pg';
import {
  encryptSocialStorageState,
  encryptSocialProxy,
  generateSocialDevice,
  socialDeviceFromOwnerBrowser,
  type SocialStorageState,
  type SocialDevice,
  type SocialSessionProxy,
  resolveSocialSession,
  socialProxyFingerprint,
  socialSessionProxies,
  normalizeSocialProxy,
  SocialSendError,
  socialSessionCheckReason,
  safeSocialSessionDiagnostic,
  type SocialSessionCheckDiagnostic,
  socialSessionCheckReasons,
  type SocialSessionCheckReason,
} from '@sonar/core/social-session';
import { isSocialQuietHours } from '@sonar/core/social-inbox-schedule';
import type { SocialNetwork } from '@sonar/core';
import { decryptTelegramSession } from '@sonar/core/telegram';
import { sonarPool } from './index.js';
import { reserveSocialAction } from './social-action.js';
import { EmailValidationError, transaction } from './email.js';
import { enqueueTask, logActivity, type TaskOutcome } from './tasks.js';

export interface SocialAccount {
  id: string;
  name: string;
  network: SocialNetwork;
  dailyLimit: number;
  sentToday: number;
  enabled: boolean;
  status: string;
  sessionStatus: string;
  reasonUk: string | null;
  sessionCheckReason: SocialSessionCheckReason | null;
  checkedAt: string | null;
  nextSendAt: Date | null;
  proxyIndex: number;
  ownerName: string | null;
  ownsAccount: boolean;
  hasOwnProxy: boolean;
  hasCredentials: boolean;
  hasTotpSecret: boolean;
  loginBlocked: boolean;
  loginChallengeKind: 'email' | 'sms' | 'captcha' | null;
  loginChallengeExpiresAt: string | null;
  sessionLostEventId: string | null;
  sessionLossActive: boolean;
  sessionLostAt: string | null;
  sessionLostReasonUk: string | null;
  keepaliveEnabled: boolean;
  device: SocialDevice | null;
  deviceSource: string | null;
  browserProfile: boolean;
  proxyPublicIp: string | null;
  proxyPublicIpCheckedAt: string | null;
  lastKeepaliveAt: string | null;
  nextKeepaliveAt: string | null;
  canSyncInbox: boolean;
  inboxPollingEnabled: boolean;
  inboxSyncComplete: boolean | null;
  inboxSyncCreated: number | null;
  inboxSyncCheckedAt: string | null;
  inboxSyncErrorUk: string | null;
  failureShotKinds: string[];
}
export interface SocialSessionAccount {
  id: string;
  channel: SocialNetwork;
  settings: Record<string, unknown>;
}
export type SocialFetchSession = {
  account: SocialSessionAccount;
  session: Awaited<ReturnType<typeof prepareSocialSession>>;
};
/** Caller holds the common account lock throughout the browser operation. */
export async function persistSocialStorageState(
  c: PoolClient,
  id: string,
  state: SocialStorageState,
  device?: SocialDevice,
) {
  // Validation happens before any write; empty/error captures preserve the last good state.
  const encrypted = encryptSocialStorageState(
    JSON.stringify(state),
    (await c.query('select channel from channel_accounts where id=$1', [id]))
      .rows[0].channel,
    secret(),
  );
  await c.query(
    "update channel_accounts set settings=(settings-'cookiesEncrypted')||$2::jsonb where id=$1",
    [
      id,
      {
        storageStateEncrypted: encrypted,
        ...(device ? { device } : {}),
        storageStateUpdatedAt: new Date().toISOString(),
      },
    ],
  );
}
export async function prepareSocialSession(
  c: PoolClient,
  account: SocialSessionAccount,
) {
  const updates: Record<string, unknown> = {};
  if (account.settings.proxyFingerprintPending === true) {
    const proxy = socialSessionProxies()[Number(account.settings.proxyIndex)];
    if (proxy) updates.proxyFingerprint = socialProxyFingerprint(proxy);
  }
  if (!account.settings.device)
    updates.device = generateSocialDevice(account.channel);
  Object.assign(account.settings, updates);
  const session = resolveSocialSession(account);
  if (!account.settings.storageStateEncrypted) {
    updates.storageStateEncrypted = encryptSocialStorageState(
      JSON.stringify(session.storageState),
      account.channel,
      secret(),
    );
  }
  if (Object.keys(updates).length) {
    await c.query(
      "update channel_accounts set settings=(settings-'cookiesEncrypted'-'proxyFingerprintPending')||$2::jsonb where id=$1",
      [account.id, updates],
    );
    Object.assign(account.settings, updates);
    delete account.settings.cookiesEncrypted;
    delete account.settings.proxyFingerprintPending;
  }
  return {
    ...session,
    storageState: session.storageState!,
    device: session.device!,
    persistDevice: async (device: SocialDevice) => {
      await c.query(
        "update channel_accounts set settings=settings||jsonb_build_object('device',$2::jsonb) where id=$1",
        [account.id, JSON.stringify(device)],
      );
      account.settings.device = device;
    },
    persistStorageState: async (
      state: SocialStorageState,
      device?: SocialDevice,
    ) => {
      await persistSocialStorageState(c, account.id, state, device);
      if (device) account.settings.device = device;
    },
    persistFailureShot: async (
      kind: 'check' | 'keepalive' | 'inbox' | 'send',
      shot: {
        at: string;
        path: string;
        stage: string;
        jpeg?: string;
        dom?: unknown;
        taskId?: string;
      },
    ) => {
      await c.query(
        "update channel_accounts set settings=jsonb_set(settings,'{failureShots}',coalesce(settings->'failureShots','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) where id=$1",
        [account.id, kind, JSON.stringify(shot)],
      );
    },
    proxyPublicIp:
      typeof account.settings.proxyPublicIp === 'string'
        ? account.settings.proxyPublicIp
        : undefined,
    proxyPublicIpCheckedAt:
      typeof account.settings.proxyPublicIpCheckedAt === 'string'
        ? account.settings.proxyPublicIpCheckedAt
        : undefined,
    persistProxyPublicIp: async (ip: string, checkedAt: string) => {
      await c.query(
        "update channel_accounts set settings=settings||jsonb_build_object('proxyPublicIp',$2::text,'proxyPublicIpCheckedAt',$3::text) where id=$1",
        [account.id, ip, checkedAt],
      );
      account.settings.proxyPublicIp = ip;
      account.settings.proxyPublicIpCheckedAt = checkedAt;
    },
  };
}
/** Reserve every account endpoint, including disabled and own-proxy accounts. */
export async function getSocialReservedProxyEndpoints(): Promise<
  SocialSessionProxy[]
> {
  const { rows } = await sonarPool.query(
    "select channel,settings from channel_accounts where channel in ('facebook','instagram','linkedin')",
  );
  const proxies = socialSessionProxies();
  const reserved: SocialSessionProxy[] = [];
  for (const account of rows) {
    if (account.settings.ownProxyEncrypted) {
      try {
        reserved.push(
          normalizeSocialProxy(
            decryptTelegramSession(
              account.settings.ownProxyEncrypted,
              secret(),
            ),
          ),
        );
      } catch {
        throw new Error('Account proxy reservation cannot be resolved');
      }
    } else if (proxies[Number(account.settings.proxyIndex)])
      reserved.push(proxies[Number(account.settings.proxyIndex)]!);
  }
  return reserved;
}
type FetchRuntime = { day?: string; count?: number; nextAt?: string };

/** The same account lock is held by sends, session checks and account edits. */
export async function acquireSocialFetchSession(
  c: PoolClient,
  network: SocialNetwork,
  dailyLimit: number,
  now = new Date(),
): Promise<SocialFetchSession | { runAt: Date } | null> {
  const { rows } = await c.query<{ id: string }>(
    "select id from channel_accounts where channel=$1 and status='active' and settings->>'sessionStatus'='valid' order by id",
    [network],
  );
  const {
    rows: [quota],
  } = await c.query(
    "select value from settings where key='social.action.daily_limit'",
  );
  if (!Number.isSafeInteger(quota?.value) || quota.value < 1)
    throw new Error('Invalid social.action.daily_limit');
  let nextAt = Infinity;
  for (const candidate of rows) {
    const {
      rows: [lock],
    } = await c.query(
      "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
      [candidate.id],
    );
    if (!lock.locked) {
      nextAt = Math.min(nextAt, now.getTime() + 1000);
      continue;
    }
    let keep = false;
    try {
      const {
        rows: [account],
      } = await c.query<SocialSessionAccount & { status: string }>(
        'select id,channel,settings,status from channel_accounts where id=$1',
        [candidate.id],
      );
      if (
        !account ||
        account.status !== 'active' ||
        account.settings.sessionStatus !== 'valid'
      )
        continue;
      let session: Awaited<ReturnType<typeof prepareSocialSession>>;
      try {
        session = await prepareSocialSession(c, account);
      } catch {
        await pauseSocialFetchSession(c, account.id);
        continue;
      }
      const action = account.settings.socialAction as
        { day?: string; counts?: Record<string, number> } | undefined;
      if (
        action?.day === now.toISOString().slice(0, 10) &&
        Object.values(action.counts ?? {}).reduce((a, b) => a + b, 0) >=
          quota.value
      ) {
        nextAt = Math.min(
          nextAt,
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
          ),
        );
        continue;
      }
      const runtime = (account.settings.sessionFetch ?? {}) as FetchRuntime;
      if (
        runtime.day === now.toISOString().slice(0, 10) &&
        (runtime.count ?? 0) >= dailyLimit
      )
        continue;
      const next = Math.max(
        Date.parse(runtime.nextAt ?? '') || 0,
        Date.parse(
          (account.settings.socialAction as { nextAt?: string } | undefined)
            ?.nextAt ?? '',
        ) || 0,
      );
      if (next > now.getTime()) {
        nextAt = Math.min(nextAt, next);
        continue;
      }
      keep = true;
      return { account, session };
    } finally {
      if (!keep) await releaseSocialFetchSession(c, candidate.id);
    }
  }
  return Number.isFinite(nextAt) ? { runAt: new Date(nextAt) } : null;
}
export async function releaseSocialFetchSession(c: PoolClient, id: string) {
  await c.query(
    "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
    [id],
  );
}
export async function pauseSocialFetchSession(
  c: PoolClient,
  id: string,
  reason: SocialSessionCheckReason = 'login_required',
  now = new Date(),
  eventKey?: string,
) {
  const reasonUk = socialSessionCheckReasons[reason];
  const lost = [
    'login_required',
    'cookies_invalid',
    'captcha',
    'checkpoint',
  ].includes(reason);
  const {
    rows: [automatic],
  } = await c.query(
    "select value from settings where key='social.auto_password_login'",
  );
  await c.query(
    `update channel_accounts set status=case when status='disabled' then status else 'paused' end,
    settings=settings||$2::jsonb||case when settings->>'healthAutoPaused'='true' then jsonb_build_object('reasonUk',settings->>'reasonUk') else '{}'::jsonb end||case when $3::boolean and coalesce(settings->>'sessionLossActive','false')<>'true'
    then jsonb_build_object('sessionLostEventId',$4::text,'sessionLostAt',$5::text,'sessionLostReasonUk',$6::text) else '{}'::jsonb end where id=$1`,
    [
      id,
      {
        loginRecoveryPending:
          automatic?.value === true &&
          (reason === 'login_required' || reason === 'cookies_invalid'),
        sessionStatus: lost ? 'invalid' : 'unconfirmed',
        checkedAt: now.toISOString(),
        sessionCheckReason: reason,
        reasonUk,
        ...(lost ? { sessionLossActive: true } : {}),
      },
      lost,
      randomUUID(),
      now.toISOString(),
      reasonUk,
    ],
  );
  const {
    rows: [current],
  } = await c.query(
    "select settings->>'sessionLostEventId' as event from channel_accounts where id=$1",
    [id],
  );
  const key = eventKey ?? current?.event ?? now.toISOString();
  if (lost)
    await recordHealthEvent(
      c,
      id,
      'session_lost',
      reasonUk,
      { eventKey: `session:${key}` },
      now,
    );
  if (
    reason === 'captcha' ||
    reason === 'checkpoint' ||
    reason === 'action_blocked' ||
    reason === 'rate_limit'
  )
    await recordHealthEvent(
      c,
      id,
      reason === 'rate_limit' ? 'rate_limited' : reason,
      reasonUk,
      {
        eventKey: `${reason === 'rate_limit' ? 'rate_limited' : reason}:${key}`,
      },
      now,
    );
}
/** Reserve only after the proxy budget is approved; task receipt makes retries idempotent. */
export async function reserveSocialFetchSession(
  c: PoolClient,
  id: string,
  requestId: string,
  gapSeconds: number,
  now = new Date(),
) {
  await c.query('begin');
  try {
    const {
      rows: [task],
    } = await c.query('select result from tasks where id=$1 for update', [
      requestId,
    ]);
    if (!task) throw new Error('Unknown social request');
    if (!task.result?.sessionFetchAccountId) {
      if (await reserveSocialAction(c, id, 'fetch', now))
        throw new Error('Social action spacing changed during reservation');
      await c.query(
        `update channel_accounts set settings=jsonb_set(settings,'{sessionFetch}',jsonb_build_object('day',$2::text,'count',case when settings->'sessionFetch'->>'day'=$2 then coalesce((settings->'sessionFetch'->>'count')::int,0)+1 else 1 end,'nextAt',$3::text)) where id=$1`,
        [
          id,
          now.toISOString().slice(0, 10),
          new Date(now.getTime() + gapSeconds * 1000).toISOString(),
        ],
      );
      await c.query(
        "update tasks set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('sessionFetchAccountId',$2::text) where id=$1",
        [requestId, id],
      );
    } else if (task.result.sessionFetchAccountId !== id)
      throw new Error('Social request already reserved another account');
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  }
}
const networks = ['facebook', 'instagram', 'linkedin'];
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
const validLimit = (limit: number) =>
  Number.isInteger(limit) && limit > 0 && limit <= 100000;
const secret = () => {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32)
    invalid('Налаштуйте AUTH_SECRET на сервері (щонайменше 32 символи).');
  return value!;
};
const proxySettings = async (index: number, ownProxy?: string | null) => {
  if (ownProxy) {
    try {
      return {
        proxyIndex: index,
        proxyFingerprint: socialProxyFingerprint(
          normalizeSocialProxy(ownProxy),
        ),
        ownProxyEncrypted: encryptSocialProxy(ownProxy, secret()),
      };
    } catch {
      return invalid('Вкажіть коректний URL власного проксі.');
    }
  }
  let proxies;
  try {
    proxies = socialSessionProxies();
  } catch {
    return invalid('Налаштуйте SOCIAL_PROXY_URLS на сервері.');
  }
  const proxy =
    Number.isInteger(index) && index >= 0 ? proxies[index] : undefined;
  if (!proxy) invalid('Виберіть доступний проксі для акаунта.');
  return {
    proxyIndex: index,
    proxyFingerprint: socialProxyFingerprint(proxy!),
    ownProxyEncrypted: null,
  };
};
export async function getSocialAccountProxyIndex(
  network: SocialNetwork = 'facebook',
): Promise<number | null> {
  const index = network === 'linkedin' ? 1 : 0;
  return getSocialProxyCount() > index ? index : null;
}
/** Host names only (no credentials), so the UI can name each proxy. */
export function getSocialProxyLabels(): string[] {
  try {
    return socialSessionProxies().map((proxy) => {
      try {
        return new URL(proxy.server).hostname;
      } catch {
        return '';
      }
    });
  } catch {
    return [];
  }
}
export function getSocialProxyCount(): number {
  try {
    return socialSessionProxies().length;
  } catch {
    return 0;
  }
}
export async function listSocialAccounts(
  userId?: string,
): Promise<SocialAccount[]> {
  const { rows } = await sonarPool.query<SocialAccount>(
    `select a.id,a.name,a.channel as network,a.daily_limit as "dailyLimit",a.status,(a.status='active') as enabled,
    coalesce(a.settings->>'sessionStatus','pending') as "sessionStatus",a.settings->>'reasonUk' as "reasonUk",a.settings->>'sessionCheckReason' as "sessionCheckReason",a.settings->>'checkedAt' as "checkedAt",
    a.next_send_at as "nextSendAt",
    (a.settings->>'credentialsEncrypted' is not null) as "hasCredentials",coalesce(a.settings->>'hasTotpSecret','false')='true' as "hasTotpSecret",coalesce(a.settings->>'loginBlocked','false')='true' as "loginBlocked",case when a.settings->>'loginChallengeKind' in ('email','sms') and (a.settings->>'loginChallengeExpiresAt')::timestamptz>now() then a.settings->>'loginChallengeKind' when a.settings->>'sessionCheckReason'='captcha' then 'captcha' else null end as "loginChallengeKind",case when (a.settings->>'loginChallengeExpiresAt')::timestamptz>now() then a.settings->>'loginChallengeExpiresAt' else null end as "loginChallengeExpiresAt",
    (a.settings->>'ownProxyEncrypted' is not null) as "hasOwnProxy",coalesce(a.settings->>'sessionLossActive','false')='true' as "sessionLossActive", a.settings->>'sessionLostEventId' as "sessionLostEventId",a.settings->>'sessionLostAt' as "sessionLostAt",a.settings->>'sessionLostReasonUk' as "sessionLostReasonUk",
    coalesce(a.settings->>'keepaliveEnabled','true')<>'false' as "keepaliveEnabled",a.settings->>'lastKeepaliveAt' as "lastKeepaliveAt",a.settings->>'nextKeepaliveAt' as "nextKeepaliveAt",(a.settings->>'proxyIndex')::int as "proxyIndex",u.name as "ownerName",coalesce(a.owner_id=$1::uuid,false) as "ownsAccount",
    coalesce(a.owner_id=$1::uuid and a.channel in ('instagram','facebook') and a.status='active' and a.settings->>'sessionStatus'='valid' and coalesce(a.settings->>'enabled','true')<>'false',false) as "canSyncInbox",
    coalesce(a.settings->>'inboxPollingEnabled'='true',false) as "inboxPollingEnabled",
    (a.settings->'inboxSync'->>'complete')::boolean as "inboxSyncComplete",
    (a.settings->'inboxSync'->>'created')::int as "inboxSyncCreated",
    a.settings->'inboxSync'->>'checkedAt' as "inboxSyncCheckedAt",
    a.settings->'inboxSync'->>'errorUk' as "inboxSyncErrorUk",
    case when $1::uuid is null or a.owner_id=$1::uuid then coalesce(array(select key from jsonb_each(coalesce(a.settings->'failureShots','{}'::jsonb)) shot(key,value) order by (value->>'at')::timestamptz desc),array[]::text[]) else array[]::text[] end as "failureShotKinds",
    a.settings->'device' as device,a.settings->>'deviceSource' as "deviceSource",coalesce(a.settings->>'browserProfile'='true',false) as "browserProfile",a.settings->>'proxyPublicIp' as "proxyPublicIp",a.settings->>'proxyPublicIpCheckedAt' as "proxyPublicIpCheckedAt",
    (select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday"
    from channel_accounts a left join users u on u.id=a.owner_id where a.channel in ('facebook','instagram','linkedin') order by a.name,a.id`,
    [userId ?? null],
  );
  return rows;
}
export async function listSocialSessionNotices(userId: string): Promise<
  {
    id: string;
    name: string;
    network: SocialNetwork;
    eventId: string;
    reasonUk: string;
  }[]
> {
  const { rows } = await sonarPool.query(
    "select id,name,channel as network,settings->>'sessionLostEventId' as \"eventId\",settings->>'sessionLostReasonUk' as \"reasonUk\" from channel_accounts where owner_id=$1 and channel in ('facebook','instagram','linkedin') and settings->>'sessionLossActive'='true' and settings->>'sessionLostEventId' is not null",
    [userId],
  );
  return rows;
}
async function lock(c: PoolClient, id: string, userId?: string) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [id],
  );
  const {
    rows: [account],
  } = await c.query(
    "select * from channel_accounts where id=$1 and channel in ('facebook','instagram','linkedin') and ($2::uuid is null or owner_id=$2) for update",
    [id, userId ?? null],
  );
  if (!account) invalid('Акаунт соцмережі не знайдено.');
  if (account.settings.proxyFingerprintPending === true) {
    const proxy = socialSessionProxies()[Number(account.settings.proxyIndex)];
    if (proxy) {
      account.settings.proxyFingerprint = socialProxyFingerprint(proxy);
      delete account.settings.proxyFingerprintPending;
      await c.query(
        "update channel_accounts set settings=(settings-'proxyFingerprintPending')||jsonb_build_object('proxyFingerprint',$2::text) where id=$1",
        [id, account.settings.proxyFingerprint],
      );
    }
  }
  return account;
}
function encryptedCookies(raw: string, network: SocialNetwork) {
  try {
    return encryptSocialStorageState(raw, network, secret());
  } catch (error) {
    if (error instanceof SocialSendError) invalid(error.reasonUk);
    throw error;
  }
}
function ownerBrowserDevice(raw: unknown): SocialDevice {
  try {
    return socialDeviceFromOwnerBrowser(raw);
  } catch {
    return invalid(
      'Параметри браузера некоректні. Оновіть сторінку та повторіть.',
    );
  }
}
export async function saveSocialAccount(
  input: {
    id?: string;
    network: SocialNetwork;
    name: string;
    cookiesJson?: string;
    storageStateJson?: string;
    ownerBrowser?: unknown;
    ownProxy?: string | null;
    keepaliveEnabled?: boolean;
    proxyIndex?: number;
    dailyLimit: number;
  },
  userId: string,
  existing?: PoolClient,
) {
  const name = input.name?.trim();
  if (
    !networks.includes(input.network) ||
    !name ||
    name.length > 200 ||
    !validLimit(input.dailyLimit)
  )
    invalid('Вкажіть соцмережу, назву та додатний денний ліміт.');
  const stateJson = input.storageStateJson ?? input.cookiesJson;
  const index = input.proxyIndex ?? (input.network === 'linkedin' ? 1 : 0);
  return transaction(async (c) => {
    const existing = input.id ? await lock(c, input.id, userId) : undefined;
    const pinned =
      existing && input.proxyIndex === undefined && input.ownProxy === undefined
        ? {
            proxyIndex: existing.settings.proxyIndex,
            proxyFingerprint: existing.settings.proxyFingerprint,
            ownProxyEncrypted: existing.settings.ownProxyEncrypted,
          }
        : await proxySettings(
            input.proxyIndex ?? existing?.settings.proxyIndex ?? index,
            input.ownProxy,
          );
    if (existing && existing.channel !== input.network)
      invalid('Соцмережу підключеного акаунта змінити неможливо.');
    const proxyChanged =
      !!existing &&
      (existing.settings.proxyFingerprint !== pinned.proxyFingerprint ||
        existing.settings.proxyIndex !== pinned.proxyIndex);
    const replaced = !!stateJson || !existing || proxyChanged;
    const ownerDevice =
      input.ownerBrowser === undefined
        ? undefined
        : ownerBrowserDevice(input.ownerBrowser);
    const settings = {
      ...existing?.settings,
      ...pinned,
      ...(proxyChanged
        ? { proxyPublicIp: null, proxyPublicIpCheckedAt: null }
        : {}),
      device:
        ownerDevice ??
        existing?.settings.device ??
        generateSocialDevice(input.network),
      ...(ownerDevice
        ? {
            deviceSource: 'owner_browser',
            deviceUpdatedAt: new Date().toISOString(),
          }
        : {}),
      ...(stateJson && !ownerDevice
        ? { deviceSource: 'unconfirmed', device: null }
        : {}),
      ...(input.keepaliveEnabled !== undefined
        ? { keepaliveEnabled: input.keepaliveEnabled }
        : {}),
      ...(stateJson
        ? {
            storageStateEncrypted: encryptedCookies(stateJson, input.network),
          }
        : {}),
      ...(replaced
        ? {
            sessionStatus: 'pending',
            checkedAt: null,
            reasonUk:
              existing?.settings.healthAutoPaused === true
                ? existing.settings.reasonUk
                : proxyChanged ||
                    existing?.settings.reasonUk ===
                      'Проксі змінено. Можлива перевірка входу.'
                  ? 'Проксі змінено. Можлива перевірка входу.'
                  : null,
            sessionCheckReason: null,
          }
        : {}),
    };
    const id = existing?.id ?? randomUUID();
    if (existing)
      await c.query(
        'update channel_accounts set name=$2,daily_limit=$3,status=$4,settings=$5 where id=$1',
        [
          id,
          name,
          input.dailyLimit,
          replaced ? 'paused' : existing.status,
          settings,
        ],
      );
    else
      await c.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,settings) values($1,$2,$3,'',$4,'paused',$5,$6)",
        [id, input.network, name, userId, input.dailyLimit, settings],
      );
    if (stateJson)
      await recordHealthEvent(
        c,
        id,
        'relogin_ok',
        'Сесію соцмережі імпортовано. Потрібна перевірка.',
        { source: 'import', eventKey: `import:${randomUUID()}` },
      );
    await logActivity(
      'social.account.saved',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return { id: String(id) };
  }, existing);
}

export async function createSocialAccountWithCredentials(
  input: {
    network: SocialNetwork;
    name: string;
    ownProxy?: string | null;
    keepaliveEnabled?: boolean;
    proxyIndex?: number;
    dailyLimit: number;
    login: string;
    password: string;
    totpSecret?: string;
  },
  userId: string,
) {
  return transaction(async (c) => {
    const saved = await saveSocialAccount(input, userId, c);
    const { saveSocialCredentials } = await import('./social-login.js');
    const loginTask = await saveSocialCredentials(
      saved.id,
      {
        login: input.login,
        password: input.password,
        ...(input.totpSecret === undefined
          ? {}
          : { totpSecret: input.totpSecret }),
      },
      userId,
      c,
    );
    if (!loginTask.id)
      invalid('Не вдалося додати вхід до черги. Перевірте ліміт спроб входу.');
    return { id: saved.id, loginTaskId: loginTask.id };
  });
}

/** Deletes a social account and detaches its message history in one transaction. */
export async function removeSocialAccount(id: string, userId: string) {
  return transaction(async (c) => {
    await lock(c, id, userId);
    await c.query(
      `update tasks t set status='skipped',reason_code='social_account_deleted',reason_uk='Акаунт видалено.',finished_at=now()
       where t.status in ('queued','paused') and (
         (t.type like 'social.session.%' and t.payload->>'accountId'=$1)
         or (t.type='social.inbox.sync' and t.payload->>'accountId'=$1)
         or (t.type='message.send' and t.payload->>'messageId' in
           (select m.id::text from messages m where m.account_id=$2))
       )`,
      [id, id],
    );
    await c.query(
      "select set_config('sonar.social_account_deleting',$1,true)",
      [id],
    );
    await c.query(
      'update conversations set account_id=null where account_id=$1',
      [id],
    );
    await c.query('update messages set account_id=null where account_id=$1', [
      id,
    ]);
    await c.query('delete from channel_accounts where id=$1', [id]);
    await logActivity(
      'social.account.removed',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}

export async function updateSocialAccount(
  id: string,
  input: {
    enabled?: boolean;
    dailyLimit?: number;
    proxyIndex?: number;
    cookiesJson?: string;
    storageStateJson?: string;
    ownerBrowser?: unknown;
    ownProxy?: string | null;
    keepaliveEnabled?: boolean;
  },
  userId: string,
) {
  if (
    !Object.keys(input).length ||
    (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
    (input.dailyLimit !== undefined && !validLimit(input.dailyLimit))
  )
    invalid('Вкажіть додатний денний ліміт та стан акаунта.');
  return transaction(async (c) => {
    const account = await lock(c, id, userId);
    const pinned =
      input.proxyIndex !== undefined || input.ownProxy !== undefined
        ? await proxySettings(
            input.proxyIndex ??
              account.settings.proxyIndex ??
              (account.channel === 'linkedin' ? 1 : 0),
            input.ownProxy,
          )
        : undefined;
    const proxyChanged =
      !!pinned &&
      (pinned.proxyFingerprint !== account.settings.proxyFingerprint ||
        pinned.proxyIndex !== account.settings.proxyIndex);
    const replaced =
      input.cookiesJson !== undefined ||
      input.storageStateJson !== undefined ||
      proxyChanged;
    const ownerDevice =
      input.ownerBrowser === undefined
        ? undefined
        : ownerBrowserDevice(input.ownerBrowser);
    const settings = {
      ...account.settings,
      ...(input.keepaliveEnabled !== undefined
        ? { keepaliveEnabled: input.keepaliveEnabled }
        : {}),
      ...pinned,
      ...(proxyChanged
        ? { proxyPublicIp: null, proxyPublicIpCheckedAt: null }
        : {}),
      ...(ownerDevice
        ? {
            device: ownerDevice,
            deviceSource: 'owner_browser',
            deviceUpdatedAt: new Date().toISOString(),
          }
        : {}),
      ...((input.storageStateJson !== undefined ||
        input.cookiesJson !== undefined) &&
      !ownerDevice
        ? { deviceSource: 'unconfirmed', device: null }
        : {}),
      ...(input.storageStateJson !== undefined ||
      input.cookiesJson !== undefined
        ? {
            storageStateEncrypted: encryptedCookies(
              (input.storageStateJson ?? input.cookiesJson)!,
              account.channel,
            ),
          }
        : {}),
      ...(replaced
        ? {
            sessionStatus: 'pending',
            checkedAt: null,
            reasonUk:
              account.settings.healthAutoPaused === true
                ? account.settings.reasonUk
                : proxyChanged ||
                    account.settings.reasonUk ===
                      'Проксі змінено. Можлива перевірка входу.'
                  ? 'Проксі змінено. Можлива перевірка входу.'
                  : null,
            sessionCheckReason: null,
          }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (
      input.enabled &&
      (replaced || settings.sessionStatus !== 'valid') &&
      account.settings.healthAutoPaused !== true
    )
      invalid('Спочатку перевірте сесію акаунта.');
    if (input.enabled && settings.sessionStatus === 'valid' && !replaced) {
      try {
        await prepareSocialSession(c, {
          id,
          channel: account.channel,
          settings,
        });
      } catch (error) {
        invalid(
          error instanceof SocialSendError
            ? error.reasonUk
            : 'Перевірте сесію акаунта.',
        );
      }
    }
    const status =
      input.enabled === false
        ? 'disabled'
        : replaced
          ? 'paused'
          : input.enabled
            ? settings.sessionStatus === 'valid'
              ? 'active'
              : 'paused'
            : account.status;
    await c.query(
      'update channel_accounts set daily_limit=$2,status=$3,settings=$4 where id=$1',
      [id, input.dailyLimit ?? account.daily_limit, status, settings],
    );
    if (input.enabled === true) await enableAccountHealth(c, id);
    if (input.storageStateJson !== undefined || input.cookiesJson !== undefined)
      await recordHealthEvent(
        c,
        id,
        'relogin_ok',
        'Сесію соцмережі імпортовано. Потрібна перевірка.',
        { source: 'import', eventKey: `import:${randomUUID()}` },
      );
    await logActivity(
      'social.account.updated',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}
/** Update only the browser device identity; cookies and session health stay untouched. */
export async function updateSocialDevice(
  id: string,
  ownerBrowser: unknown,
  userId: string,
) {
  const device = ownerBrowserDevice(ownerBrowser);
  return transaction(async (c) => {
    const account = await lock(c, id, userId);
    const settings = {
      ...account.settings,
      device,
      deviceSource: 'owner_browser',
      deviceUpdatedAt: new Date().toISOString(),
    };
    await c.query('update channel_accounts set settings=$2 where id=$1', [
      id,
      settings,
    ]);
    await logActivity(
      'social.account.device_updated',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}
export async function checkSocialSession(id: string, userId: string) {
  return transaction(async (c) => {
    await lock(c, id, userId);
    const {
      rows: [pending],
    } = await c.query(
      "select id from tasks where type='social.session.check' and payload->>'accountId'=$1 and status in ('queued','running') order by created_at desc limit 1",
      [id],
    );
    if (pending) return { id: String(pending.id), created: false };
    const taskId = await enqueueTask(
      'social.session.check',
      `social.session.check:${id}:${randomUUID()}`,
      { accountId: id },
      c,
    );
    if (taskId) {
      await c.query(
        "update tasks set subject_type='channel_account',subject_id=$2 where id=$1",
        [taskId, id],
      );
      await logActivity(
        'social.session.check.queued',
        'channel_account',
        id,
        userId,
        { taskId },
        c,
      );
    }
    return { id: taskId, created: !!taskId };
  });
}
/** Owner action only. The persisted receipt, not a client flag, authorizes one run. */
export async function syncSocialInbox(id: string, userId: string) {
  return transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('social-inbox-reconcile',0))",
    );
    const account = await lock(c, id, userId);
    if (
      !['instagram', 'facebook'].includes(account.channel) ||
      account.status !== 'active' ||
      account.settings.enabled === false ||
      account.settings.sessionStatus !== 'valid'
    )
      invalid(
        'Ручна синхронізація доступна лише власнику активного Instagram або Facebook із підтвердженою сесією.',
      );
    try {
      await prepareSocialSession(c, account);
    } catch (error) {
      invalid(
        error instanceof SocialSendError
          ? error.reasonUk
          : 'Перевірте сесію та закріплений проксі акаунта.',
      );
    }
    // The account lock proves no browser for this account is still running.
    // Recover only this owner's abandoned manual task, without polling/reconcile.
    await c.query(
      `update tasks t set status='failed',finished_at=now(),reason_code='social_inbox_interrupted',
      reason_uk='Разову синхронізацію перервано. Повторіть вручну.'
      where t.type='social.inbox.sync' and t.payload->>'accountId'=$1 and t.payload->>'mode'='manual'
      and t.status in ('queued','running') and not exists(select 1 from pgboss.job j
        where j.name='social.inbox.sync' and j.data->>'taskId'=t.id::text and j.state in ('created','retry','active'))`,
      [id],
    );
    const {
      rows: [pending],
    } = await c.query(
      "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running') limit 1",
      [id],
    );
    if (pending) return { id: String(pending.id), created: false };
    const taskId = await enqueueTask(
      'social.inbox.sync',
      `social.inbox.sync:${id}:${randomUUID()}`,
      { accountId: id, mode: 'manual', requestedBy: userId },
      c,
    );
    if (!taskId) throw new Error('Manual inbox task was not created');
    await c.query(
      "update tasks set subject_type='channel_account',subject_id=$2 where id=$1",
      [taskId, id],
    );
    await logActivity(
      'social.inbox.manual.queued',
      'channel_account',
      id,
      userId,
      { taskId },
      c,
    );
    return { id: taskId as string, created: true };
  });
}
export async function setSocialInboxPolling(
  id: string,
  enabled: boolean,
  userId: string,
) {
  return transaction(async (c) => {
    const account = await lock(c, id, userId);
    if (
      !['instagram', 'facebook'].includes(account.channel) ||
      (enabled &&
        (account.status !== 'active' ||
          account.settings.enabled === false ||
          account.settings.sessionStatus !== 'valid'))
    )
      invalid(
        'Опитування доступне власнику активного Instagram або Facebook із підтвердженою сесією.',
      );
    await c.query(
      "update channel_accounts set settings=settings||jsonb_build_object('inboxPollingEnabled',$2::boolean,'inboxSync',coalesce(settings->'inboxSync','{}'::jsonb)||jsonb_build_object('errorUk',null)) where id=$1",
      [id, enabled],
    );
    await logActivity(
      'social.inbox.polling.updated',
      'channel_account',
      id,
      userId,
      { enabled },
      c,
    );
  });
}
export async function withSocialSessionCheck(
  id: string,
  check: (
    account: SocialSessionAccount,
    session: Awaited<ReturnType<typeof prepareSocialSession>>,
  ) => Promise<{
    valid: boolean;
    reason?: SocialSessionCheckReason;
    diagnostic?: SocialSessionCheckDiagnostic;
    busy?: boolean;
    result?: Record<string, unknown>;
  }>,
  now = new Date(),
  mode: 'check' | 'keepalive' | 'recipient' = 'check',
  taskId?: string,
): Promise<TaskOutcome> {
  const c = await sonarPool.connect();
  let locked = false;
  let inTransaction = false;
  try {
    // Keep the common account lock across the callback, without a SQL transaction.
    const {
      rows: [lease],
    } = await c.query(
      "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
      [id],
    );
    locked = lease.locked === true;
    if (!locked) {
      const {
        rows: [setting],
      } = await c.query(
        "select value from settings where key='social.profile.busy_retry_seconds'",
      );
      const retrySeconds = Number(setting?.value);
      if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1)
        throw new Error('Invalid social.profile.busy_retry_seconds');
      return {
        status: 'deferred',
        runAt: new Date(now.getTime() + retrySeconds * 1000),
        reasonCode: 'social_profile_busy',
        reasonUk: 'Браузер акаунта зайнятий.',
      };
    }
    await c.query('begin');
    inTransaction = true;
    const account = await lock(c, id);
    if (mode === 'keepalive') {
      const {
        rows: [enabled],
      } = await c.query(
        "select value from settings where key='social.keepalive.enabled'",
      );
      if (
        enabled?.value !== true ||
        account.status !== 'active' ||
        account.settings.enabled === false ||
        account.settings.sessionStatus !== 'valid' ||
        account.settings.keepaliveEnabled === false
      ) {
        await c.query('commit');
        inTransaction = false;
        return {
          status: 'skipped',
          reasonCode: 'social_keepalive_disabled',
          reasonUk: 'Підтримку сесії вимкнено або сесія потребує перевірки.',
        };
      }
    }
    if (mode === 'keepalive') {
      const due = Date.parse(account.settings.nextKeepaliveAt ?? '');
      if (due > now.getTime()) {
        await c.query('commit');
        inTransaction = false;
        return {
          status: 'deferred',
          runAt: new Date(due),
          reasonCode: 'social_keepalive_scheduled',
          reasonUk: 'Підтримка сесії запланована на наступний інтервал.',
        };
      }
    }
    let session: Awaited<ReturnType<typeof prepareSocialSession>> | undefined;
    let valid = false;
    let diagnostic: SocialSessionCheckDiagnostic | undefined;
    let checkResult: Record<string, unknown> | undefined;
    let reason: SocialSessionCheckReason | undefined;
    try {
      session = await prepareSocialSession(c, account);
    } catch (error) {
      reason = socialSessionCheckReason(error);
    }
    const runAt =
      reason || mode === 'recipient'
        ? null
        : await reserveSocialAction(c, id, mode, now);
    await c.query('commit');
    inTransaction = false;
    if (runAt)
      return {
        status: 'deferred',
        runAt,
        reasonCode: 'social_action_gate',
        reasonUk: 'Перевірка сесії після спільної паузи дій акаунта.',
      };
    if (!reason) {
      try {
        const result = await check(account, session!);
        valid = result.valid;
        checkResult = result.result;
        diagnostic = safeSocialSessionDiagnostic(result.diagnostic);
        if (result.busy) {
          const {
            rows: [setting],
          } = await c.query(
            "select value from settings where key='social.profile.busy_retry_seconds'",
          );
          const retrySeconds = Number(setting?.value);
          if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1)
            throw new Error('Invalid social.profile.busy_retry_seconds');
          return {
            status: 'deferred',
            runAt: new Date(now.getTime() + retrySeconds * 1000),
            reasonCode: 'social_profile_busy',
            reasonUk: 'Браузер акаунта зайнятий.',
          };
        }
        if (!valid)
          reason =
            result.reason &&
            Object.hasOwn(socialSessionCheckReasons, result.reason)
              ? result.reason
              : 'unknown_auth';
      } catch (error) {
        reason = socialSessionCheckReason(error);
      }
    }
    const reasonUk = reason ? socialSessionCheckReasons[reason] : null;
    if (mode === 'recipient')
      return valid
        ? {
            status: 'done',
            result: { valid: true, ...(checkResult ?? {}) },
          }
        : [
              'login_required',
              'cookies_invalid',
              'captcha',
              'checkpoint',
            ].includes(reason ?? '')
          ? {
              status: 'paused',
              reasonCode: `social_session_${reason}`,
              reasonUk: reasonUk!,
              result: {
                valid: false,
                ...(diagnostic ? { diagnostic } : {}),
                ...(checkResult ?? {}),
              },
            }
          : {
              status: 'failed',
              reasonCode: `social_session_${reason ?? 'unknown_auth'}`,
              reasonUk:
                reasonUk ??
                'Не вдалося перевірити Facebook. Потрібна дія: відкрийте «Канали» й перевірте акаунт.',
              result: {
                valid: false,
                ...(diagnostic ? { diagnostic } : {}),
                ...(checkResult ?? {}),
              },
            };
    if (
      mode === 'keepalive' &&
      reason &&
      ['timeout', 'network', 'browser', 'rate_limit'].includes(reason)
    ) {
      const { rows } = await c.query(
        "select key,value from settings where key in ('social.keepalive.retry_seconds','social.keepalive.interval_seconds')",
      );
      const config = Object.fromEntries(
        rows.map((row) => [row.key, row.value]),
      );
      const retry = config['social.keepalive.retry_seconds'];
      const interval = config['social.keepalive.interval_seconds'];
      if (
        !Number.isSafeInteger(retry) ||
        retry < 1 ||
        !Number.isSafeInteger(interval) ||
        retry > interval
      )
        throw new Error('Invalid social.keepalive.retry_seconds');
      const runAt = new Date(now.getTime() + retry * 1000);
      // A transport failure is not evidence of lost authentication. Keep the last verified session.
      await c.query(
        'update channel_accounts set settings=settings||$2::jsonb where id=$1',
        [
          id,
          {
            lastKeepaliveAt: now.toISOString(),
            lastKeepaliveReason: reason,
            nextKeepaliveAt: runAt.toISOString(),
          },
        ],
      );
      return {
        status: 'deferred',
        runAt,
        reasonCode: `social_keepalive_${reason}`,
        reasonUk: reasonUk!,
        result: {
          valid: false,
          retry: true,
          ...(diagnostic ? { diagnostic } : {}),
        },
      };
    }
    let timeoutCount = 0;
    let timeoutLimit = 0;
    if (!valid && mode === 'check') {
      const { rows: settings } = await c.query(
        "select key,value from settings where key in ('social.session.check.timeout_limit','social.session.check.retry_seconds')",
      );
      const config = Object.fromEntries(
        settings.map((setting) => [setting.key, setting.value]),
      );
      timeoutLimit = Number(config['social.session.check.timeout_limit']);
      const retrySeconds = Number(config['social.session.check.retry_seconds']);
      if (
        !Number.isSafeInteger(timeoutLimit) ||
        timeoutLimit < 1 ||
        !Number.isSafeInteger(retrySeconds) ||
        retrySeconds < 1
      )
        throw new Error('Invalid social.session.check retry settings');
      timeoutCount =
        reason === 'timeout'
          ? Math.max(
              0,
              Number(account.settings.sessionCheckTimeoutCount) || 0,
            ) + 1
          : 0;
      await c.query(
        "update channel_accounts set settings=settings||jsonb_build_object('sessionCheckTimeoutCount',$2::int) where id=$1",
        [id, timeoutCount],
      );
      if (reason !== 'timeout' || timeoutCount < timeoutLimit) {
        const {
          rows: [pending],
        } = await c.query(
          "select id from tasks where type='social.session.check' and payload->>'accountId'=$1 and status in ('queued','running') and id<>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) limit 1",
          [id, taskId ?? null],
        );
        if (!pending)
          await enqueueTask(
            'social.session.check',
            `social.session.check:${id}:retry:${now.getTime()}`,
            { accountId: id },
            c,
            new Date(now.getTime() + retrySeconds * 1000),
          );
      } else {
        await c.query(
          `update tasks set status='paused',finished_at=$2::timestamptz,
          reason_code='social_session_timeout',reason_uk=$3
          where type='social.session.check' and payload->>'accountId'=$1
            and status='queued' and id<>coalesce($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
          [id, now.toISOString(), reasonUk, taskId ?? null],
        );
      }
    }
    const authFailure =
      !!reason &&
      [
        'login_required',
        'cookies_invalid',
        'captcha',
        'checkpoint',
        'action_blocked',
      ].includes(reason);
    if (
      !valid &&
      (authFailure || (timeoutLimit > 0 && timeoutCount >= timeoutLimit))
    ) {
      await c.query('begin');
      inTransaction = true;
      await pauseSocialFetchSession(c, id, reason ?? 'unknown_auth', now);
      if (reason === 'login_required' || reason === 'cookies_invalid') {
        const {
          rows: [setting],
        } = await c.query(
          "select value from settings where key='social.auto_password_login'",
        );
        if (setting?.value === true)
          await queueAutomaticSocialRelogin(c, id, now);
      }
      await c.query('commit');
      inTransaction = false;
    } else if (valid) {
      await c.query('begin');
      inTransaction = true;
      await c.query(
        'update channel_accounts set status=$2,settings=settings||$3::jsonb where id=$1',
        [
          id,
          account.settings.enabled === false
            ? 'disabled'
            : account.settings.healthAutoPaused === true
              ? 'paused'
              : 'active',
          {
            sessionStatus: 'valid',
            ...(account.settings.inboxPollingEnabled === undefined
              ? { inboxPollingEnabled: true }
              : {}),
            sessionLossActive: false,
            loginAutoAttempted: false,
            loginRecoveryPending: false,
            checkedAt: now.toISOString(),
            sessionCheckReason: null,
            sessionCheckTimeoutCount: 0,
            reasonUk:
              account.settings.healthAutoPaused === true
                ? account.settings.reasonUk
                : null,
          },
        ],
      );
      if (
        account.settings.enabled !== false &&
        account.settings.healthAutoPaused !== true
      )
        await resumePausedSends(c, id, true);
      await c.query('commit');
      inTransaction = false;
    }
    if (
      valid &&
      (account.settings.sessionLossActive ||
        ['invalid', 'unconfirmed'].includes(
          String(account.settings.sessionStatus),
        ))
    )
      await recordHealthEvent(
        c,
        id,
        'relogin_ok',
        'Сесію соцмережі підтверджено.',
        {
          eventKey: `check:${account.settings.storageStateUpdatedAt ?? account.settings.sessionLostEventId ?? now.toISOString()}`,
        },
      );
    if (mode === 'keepalive' || valid) {
      const nextAt = await nextSocialKeepalive(c, now);
      await c.query(
        'update channel_accounts set settings=settings||$2::jsonb where id=$1',
        [
          id,
          {
            ...(mode === 'keepalive'
              ? {
                  lastKeepaliveAt: now.toISOString(),
                  lastKeepaliveReason: reason ?? null,
                }
              : {}),
            nextKeepaliveAt: nextAt.toISOString(),
          },
        ],
      );
    }
    return valid
      ? {
          status: 'done',
          result: { valid: true, ...(checkResult ?? {}) },
        }
      : authFailure || (timeoutLimit > 0 && timeoutCount >= timeoutLimit)
        ? {
            status: 'paused',
            result: {
              valid: false,
              ...(diagnostic ? { diagnostic } : {}),
              ...(checkResult ?? {}),
            },
            reasonCode: `social_session_${reason}`,
            reasonUk: reasonUk!,
          }
        : {
            status: 'failed',
            result: {
              valid: false,
              ...(diagnostic ? { diagnostic } : {}),
              ...(checkResult ?? {}),
            },
            reasonCode: `social_session_${reason}`,
            reasonUk: reasonUk!,
          };
  } catch (error) {
    if (inTransaction) await c.query('rollback');
    throw error;
  } finally {
    if (locked) await releaseSocialFetchSession(c, id);
    c.release();
  }
}

async function nextSocialKeepalive(c: PoolClient, now: Date) {
  const { rows } = await c.query(
    "select key,value from settings where key in ('social.keepalive.interval_seconds','social.keepalive.jitter_seconds','social.inbox.quiet_hours','social.inbox.timezone')",
  );
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const interval = settings['social.keepalive.interval_seconds'];
  const jitter = settings['social.keepalive.jitter_seconds'];
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(jitter) ||
    jitter < 0 ||
    jitter >= interval
  )
    throw new Error('Invalid social keepalive schedule');
  let next = new Date(
    now.getTime() +
      (interval + Math.floor(Math.random() * (2 * jitter + 1)) - jitter) * 1000,
  );
  const quietHours = String(
    settings['social.inbox.quiet_hours'] ?? '00:00-07:00',
  );
  const timeZone = String(settings['social.inbox.timezone'] ?? 'Europe/Kyiv');
  while (isSocialQuietHours(next, quietHours, timeZone))
    next = new Date(next.getTime() + 3600000);
  return next;
}
/** Reconcile durable single-flight jobs after restarts; disabled accounts never open browsers. */
export async function reconcileSocialSessionKeepalive(now = new Date()) {
  return transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('social-keepalive-reconcile',0))",
    );
    const {
      rows: [enabled],
    } = await c.query(
      "select value from settings where key='social.keepalive.enabled'",
    );
    if (enabled?.value !== true) return 0;
    await c.query(`update tasks t set status='failed',finished_at=now(),reason_code='social_keepalive_interrupted',reason_uk='Підтримку сесії перервано. Заплановано повтор.'
      where t.type='social.session.keepalive' and t.status in ('queued','running')
      and not exists(select 1 from pgboss.job j where j.name=t.type and j.data->>'taskId'=t.id::text and j.state in ('created','retry','active'))
      and pg_try_advisory_xact_lock(hashtextextended('channel-account:'||(t.payload->>'accountId'),0))`);
    const { rows } = await c.query(
      "select id,settings from channel_accounts where channel in ('facebook','instagram','linkedin') and status='active' and settings->>'sessionStatus'='valid' and coalesce(settings->>'enabled','true')<>'false' and coalesce(settings->>'keepaliveEnabled','true')<>'false'",
    );
    let count = 0;
    for (const candidate of rows) {
      const account = await lock(c, candidate.id);
      if (
        account.status !== 'active' ||
        account.settings.enabled === false ||
        account.settings.sessionStatus !== 'valid' ||
        account.settings.keepaliveEnabled === false
      )
        continue;
      const {
        rows: [pending],
      } = await c.query(
        "select id from tasks where type='social.session.keepalive' and payload->>'accountId'=$1 and status in ('queued','running') limit 1",
        [account.id],
      );
      if (pending) continue;
      const due = Date.parse(account.settings.nextKeepaliveAt ?? '');
      const runAt = Number.isFinite(due)
        ? new Date(Math.max(now.getTime(), due))
        : await nextSocialKeepalive(c, now);
      if (!Number.isFinite(due))
        await c.query(
          "update channel_accounts set settings=settings||jsonb_build_object('nextKeepaliveAt',$2::text) where id=$1",
          [account.id, runAt.toISOString()],
        );
      await enqueueTask(
        'social.session.keepalive',
        `social.session.keepalive:${account.id}:${randomUUID()}`,
        { accountId: account.id },
        c,
        runAt,
      );
      count++;
    }
    return count;
  });
}
