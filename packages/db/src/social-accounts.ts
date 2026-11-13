import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  encryptSocialCookies,
  resolveSocialSession,
  socialProxyFingerprint,
  socialSessionProxies,
  SocialSendError,
} from '@sonar/core/social-session';
import type { SocialNetwork } from '@sonar/core';
import { sonarPool } from './index.js';
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
  checkedAt: string | null;
  nextSendAt: Date | null;
  proxyIndex: number;
  ownerName: string | null;
}
export interface SocialSessionAccount {
  id: string;
  channel: SocialNetwork;
  settings: Record<string, unknown>;
}
export type SocialFetchSession = {
  account: SocialSessionAccount;
  session: ReturnType<typeof resolveSocialSession>;
};
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
      let session: ReturnType<typeof resolveSocialSession>;
      try {
        session = resolveSocialSession(account);
      } catch {
        await pauseSocialFetchSession(c, account.id);
        continue;
      }
      const runtime = (account.settings.sessionFetch ?? {}) as FetchRuntime;
      if (
        runtime.day === now.toISOString().slice(0, 10) &&
        (runtime.count ?? 0) >= dailyLimit
      )
        continue;
      const next = Date.parse(runtime.nextAt ?? '');
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
export async function pauseSocialFetchSession(c: PoolClient, id: string) {
  await c.query(
    `update channel_accounts set status='paused',settings=settings||$2::jsonb where id=$1`,
    [
      id,
      JSON.stringify({
        sessionStatus: 'invalid',
        checkedAt: new Date().toISOString(),
        reasonUk: 'Увійдіть знову (оновіть cookies)',
      }),
    ],
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
const proxySettings = (index: number) => {
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
  };
};
export function getSocialProxyCount(): number {
  try {
    return socialSessionProxies().length;
  } catch {
    return 0;
  }
}
export async function listSocialAccounts(): Promise<SocialAccount[]> {
  const { rows } = await sonarPool.query<SocialAccount>(
    `select a.id,a.name,a.channel as network,a.daily_limit as "dailyLimit",a.status,(a.status='active') as enabled,
    coalesce(a.settings->>'sessionStatus','pending') as "sessionStatus",a.settings->>'reasonUk' as "reasonUk",a.settings->>'checkedAt' as "checkedAt",
    a.next_send_at as "nextSendAt",(a.settings->>'proxyIndex')::int as "proxyIndex",u.name as "ownerName",
    (select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday"
    from channel_accounts a left join users u on u.id=a.owner_id where a.channel in ('facebook','instagram','linkedin') order by a.name,a.id`,
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
  return account;
}
function encryptedCookies(raw: string, network: SocialNetwork) {
  try {
    return encryptSocialCookies(raw, network, secret());
  } catch (error) {
    if (error instanceof SocialSendError) invalid(error.reasonUk);
    throw error;
  }
}
export async function saveSocialAccount(
  input: {
    id?: string;
    network: SocialNetwork;
    name: string;
    cookiesJson?: string;
    proxyIndex: number;
    dailyLimit: number;
  },
  userId: string,
) {
  const name = input.name?.trim();
  if (
    !networks.includes(input.network) ||
    !name ||
    name.length > 200 ||
    !validLimit(input.dailyLimit)
  )
    invalid('Вкажіть соцмережу, назву та додатний денний ліміт.');
  const pinned = proxySettings(input.proxyIndex);
  return transaction(async (c) => {
    const existing = input.id ? await lock(c, input.id, userId) : undefined;
    if (existing && existing.channel !== input.network)
      invalid('Соцмережу підключеного акаунта змінити неможливо.');
    if (!existing && !input.cookiesJson)
      invalid('Додайте cookies у форматі JSON Cookie-Editor.');
    const replaced =
      !!input.cookiesJson ||
      !existing ||
      existing.settings.proxyFingerprint !== pinned.proxyFingerprint ||
      existing.settings.proxyIndex !== pinned.proxyIndex;
    const settings = {
      ...existing?.settings,
      ...pinned,
      ...(input.cookiesJson
        ? {
            cookiesEncrypted: encryptedCookies(
              input.cookiesJson,
              input.network,
            ),
          }
        : {}),
      ...(replaced
        ? { sessionStatus: 'pending', checkedAt: null, reasonUk: null }
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
    await logActivity(
      'social.account.saved',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return { id: String(id) };
  });
}
export async function updateSocialAccount(
  id: string,
  input: {
    enabled?: boolean;
    dailyLimit?: number;
    proxyIndex?: number;
    cookiesJson?: string;
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
    const replaced =
      input.cookiesJson !== undefined || input.proxyIndex !== undefined;
    const settings = {
      ...account.settings,
      ...(input.proxyIndex !== undefined
        ? proxySettings(input.proxyIndex)
        : {}),
      ...(input.cookiesJson !== undefined
        ? {
            cookiesEncrypted: encryptedCookies(
              input.cookiesJson,
              account.channel,
            ),
          }
        : {}),
      ...(replaced
        ? { sessionStatus: 'pending', checkedAt: null, reasonUk: null }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (input.enabled && (replaced || settings.sessionStatus !== 'valid'))
      invalid('Спочатку перевірте сесію акаунта.');
    if (input.enabled) {
      try {
        resolveSocialSession({ channel: account.channel, settings });
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
            ? 'active'
            : account.status;
    await c.query(
      'update channel_accounts set daily_limit=$2,status=$3,settings=$4 where id=$1',
      [id, input.dailyLimit ?? account.daily_limit, status, settings],
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
export async function withSocialSessionCheck(
  id: string,
  check: (
    account: SocialSessionAccount,
  ) => Promise<{ valid: boolean; reason?: string }>,
): Promise<TaskOutcome> {
  return transaction(async (c) => {
    const account = await lock(c, id);
    let valid = false,
      reason: string | undefined;
    try {
      resolveSocialSession(account);
      const result = await check(account);
      valid = result.valid;
      if (!valid) reason = 'Увійдіть знову (оновіть cookies)';
    } catch (error) {
      reason =
        error instanceof SocialSendError
          ? error.reasonUk
          : 'Не вдалося перевірити сесію соцмережі. Повторіть перевірку.';
    }
    const settings = {
      ...account.settings,
      sessionStatus: valid ? 'valid' : 'invalid',
      checkedAt: new Date().toISOString(),
      reasonUk: reason ?? null,
    };
    await c.query(
      'update channel_accounts set status=$2,settings=$3 where id=$1',
      [
        id,
        account.settings.enabled === false
          ? 'disabled'
          : valid
            ? 'active'
            : 'paused',
        settings,
      ],
    );
    return valid
      ? { status: 'done', result: { valid: true } }
      : {
          status: 'paused',
          reasonCode: 'social_session_invalid',
          reasonUk: reason!,
        };
  });
}
