import { recordHealthEvent } from './account-health.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  decryptSocialCredentials,
  encryptSocialCredentials,
  encryptSocialLoginCode,
  decryptSocialLoginCode,
} from '@sonar/core/social-login';
import {
  generateSocialDevice,
  resolveSocialSession,
  socialProxyFingerprint,
  socialSessionProxies,
  type ResolvedSocialSession,
} from '@sonar/core/social-session';
import { sonarPool } from './index.js';
import { EmailValidationError, transaction } from './email.js';
import { enqueueTask, logActivity, type TaskOutcome } from './tasks.js';
import {
  persistSocialStorageState,
  releaseSocialFetchSession,
  type SocialSessionAccount,
} from './social-accounts.js';

const secret = () => process.env.AUTH_SECRET ?? '';
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
async function account(c: PoolClient, id: string, userId?: string) {
  const {
    rows: [row],
  } = await c.query(
    "select id,channel,settings,status from channel_accounts where id=$1 and channel in ('facebook','instagram','linkedin') and ($2::uuid is null or owner_id=$2) for update",
    [id, userId ?? null],
  );
  if (!row) invalid('Акаунт соцмережі не знайдено.');
  return row;
}
async function lock(c: PoolClient, id: string) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [id],
  );
}
async function config(c: PoolClient) {
  const { rows } = await c.query(
    "select key,value from settings where key in ('social.login.daily_limit','social.login.relogin_cooldown_hours','social.login.code_timeout_seconds')",
  );
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const daily = settings['social.login.daily_limit'];
  const cooldown = settings['social.login.relogin_cooldown_hours'];
  const timeout = settings['social.login.code_timeout_seconds'];
  if (
    !Number.isSafeInteger(daily) ||
    daily < 1 ||
    !Number.isFinite(cooldown) ||
    cooldown < 1 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 600
  )
    throw new Error('Invalid social login settings');
  return { daily, cooldown, timeout };
}
async function queue(
  c: PoolClient,
  row: Awaited<ReturnType<typeof account>>,
  automatic: boolean,
  now = new Date(),
) {
  if (!row.settings.credentialsEncrypted)
    invalid('Спочатку збережіть логін і пароль.');
  if (row.settings.loginBlocked)
    invalid('Оновіть неправильний пароль перед повторним входом.');
  const { daily } = await config(c);
  if (
    row.settings.loginAttemptDay === now.toISOString().slice(0, 10) &&
    Number(row.settings.loginAttemptCount) >= daily
  )
    throw Object.assign(
      new EmailValidationError(
        'Денний ліміт спроб входу вичерпано. Спробуйте завтра.',
      ),
      { code: 'social_login_daily_limit' },
    );
  const {
    rows: [pending],
  } = await c.query(
    "select id from tasks where type='social.session.login' and payload->>'accountId'=$1 and status in ('queued','running','paused') and (status<>'paused' or id::text=$2) order by created_at desc limit 1",
    [row.id, row.settings.loginTaskId ?? null],
  );
  if (pending) return { id: String(pending.id), created: false };
  const id = await enqueueTask(
    'social.session.login',
    `social.session.login:${row.id}:${randomUUID()}`,
    { accountId: row.id, automatic },
    c,
  );
  if (!id) throw new Error('Login task was not created');
  await c.query(
    "update tasks set subject_type='channel_account',subject_id=$2 where id=$1",
    [id, row.id],
  );
  return { id: String(id), created: true };
}
export async function saveSocialCredentials(
  id: string,
  input: { login?: string; password?: string; totpSecret?: string | null },
  userId: string,
  existing?: PoolClient,
) {
  return transaction(async (c) => {
    await lock(c, id);
    const row = await account(c, id, userId);
    let old: ReturnType<typeof decryptSocialCredentials> | undefined;
    if (row.settings.credentialsEncrypted)
      old = decryptSocialCredentials(
        row.settings.credentialsEncrypted,
        secret(),
      );
    const credentials = {
      login: input.login?.trim() || old?.login || '',
      password: input.password || old?.password || '',
      ...(input.totpSecret === null
        ? {}
        : { totpSecret: input.totpSecret?.trim() || old?.totpSecret }),
    };
    let encrypted: string;
    try {
      encrypted = encryptSocialCredentials(credentials, secret());
    } catch {
      return invalid(
        'Вкажіть логін, пароль і коректний секрет TOTP; перевірте AUTH_SECRET сервера.',
      );
    }
    const changed = old && old.password !== credentials.password;
    row.settings = {
      ...row.settings,
      credentialsEncrypted: encrypted,
      hasTotpSecret: !!credentials.totpSecret,
      ...(changed ? { loginBlocked: false } : {}),
    };
    await c.query('update channel_accounts set settings=$2 where id=$1', [
      id,
      row.settings,
    ]);
    await logActivity(
      'social.credentials.saved',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    // Saving the same wrong password must persist without authorizing another attempt.
    if (row.settings.loginBlocked) return { id: null, created: false };
    try {
      return await queue(c, row, false);
    } catch (error) {
      if (
        error instanceof EmailValidationError &&
        'code' in error &&
        error.code === 'social_login_daily_limit'
      )
        return {
          id: null,
          created: false,
          reasonCode: 'social_login_daily_limit' as const,
        };
      throw error;
    }
  }, existing);
}
export async function queueSocialCredentialLogin(id: string, userId: string) {
  return transaction(async (c) => {
    await lock(c, id);
    return queue(c, await account(c, id, userId), false);
  });
}
/** Called while S1 already holds the common account lock. */
export async function queueAutomaticSocialRelogin(
  c: PoolClient,
  id: string,
  now: Date,
) {
  const row = await account(c, id);
  const {
    rows: [automatic],
  } = await c.query(
    "select value from settings where key='social.auto_password_login'",
  );
  // Consume durable S1 intent under the account lock, including ineligible accounts.
  await c.query(
    "update channel_accounts set settings=settings-'loginRecoveryPending' where id=$1",
    [id],
  );
  if (automatic?.value !== true) return false;
  if (
    row.status === 'disabled' ||
    row.settings.enabled === false ||
    !row.settings.credentialsEncrypted ||
    row.settings.loginBlocked ||
    row.settings.loginAutoAttempted
  )
    return false;
  const { cooldown } = await config(c);
  if (
    (Date.parse(row.settings.lastAutoLoginAt ?? '') || 0) + cooldown * 3600000 >
    now.getTime()
  )
    return false;
  try {
    const queued = await queue(c, row, true, now);
    await c.query(
      'update channel_accounts set settings=settings||$2::jsonb where id=$1',
      [
        id,
        {
          loginAutoAttempted: true,
          lastAutoLoginAt: now.toISOString(),
          sessionLossActive: false,
        },
      ],
    );
    return !!queued.id;
  } catch (error) {
    if (error instanceof EmailValidationError) return false;
    throw error;
  }
}
/** No advisory account lock: the live browser owns it while awaiting the code. */
export async function submitSocialLoginCode(
  id: string,
  code: string,
  userId: string,
) {
  let encrypted: string;
  try {
    encrypted = encryptSocialLoginCode(code, secret());
  } catch {
    return invalid('Вкажіть код підтвердження з повідомлення.');
  }
  const { rowCount } = await sonarPool.query(
    `update channel_accounts a set settings=jsonb_set(settings,'{loginCodeEncrypted}',to_jsonb($3::text)) where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin') and settings->>'loginChallengeKind' in ('email','sms') and (settings->>'loginChallengeExpiresAt')::timestamptz>now() and exists(select 1 from tasks t where t.id::text=a.settings->>'loginTaskId' and t.status='paused' and t.type='social.session.login')`,
    [id, userId, encrypted],
  );
  if (!rowCount) invalid('Час введення коду минув. Запустіть вхід повторно.');
  return true;
}
export type SocialCredentialLoginResult = {
  valid: boolean;
  reason?:
    | 'wrong_password'
    | 'captcha'
    | 'checkpoint'
    | 'code_expired'
    | 'login_failed';
  /** JPEG (base64) of the page at the failure, for the owner to review. */
  screenshot?: string;
};
const reasons = {
  wrong_password:
    'Неправильний пароль. Оновіть пароль у Sonar перед повторною спробою.',
  captcha:
    'Потрібна капча. Увійдіть через браузер вручну та імпортуйте сесію в Sonar.',
  checkpoint:
    'Потрібна перевірка особи. Пройдіть її вручну та імпортуйте сесію в Sonar.',
  code_expired: 'Час введення коду минув. Запустіть вхід повторно.',
  login_failed: 'Не вдалося увійти. Перевірте дані та повторіть вхід.',
};
async function finishFailure(
  c: PoolClient,
  id: string,
  reason: keyof typeof reasons,
  now: Date,
  eventKey?: string,
) {
  await c.query(
    `update channel_accounts set status=case when status='disabled' then status else 'paused' end,settings=(settings-'loginCodeEncrypted'-'loginChallengeKind'-'loginChallengeExpiresAt'-'loginTaskId')||$2::jsonb||case when settings->>'healthAutoPaused'='true' then jsonb_build_object('reasonUk',settings->>'reasonUk') else '{}'::jsonb end where id=$1`,
    [
      id,
      {
        loginRecoveryPending: false,
        sessionStatus: 'invalid',
        sessionCheckReason:
          reason === 'captcha'
            ? 'captcha'
            : reason === 'checkpoint'
              ? 'checkpoint'
              : 'login_required',
        reasonUk: reasons[reason],
        sessionLossActive: true,
        sessionLostEventId: randomUUID(),
        sessionLostAt: now.toISOString(),
        sessionLostReasonUk: reasons[reason],
        ...(reason === 'wrong_password' ? { loginBlocked: true } : {}),
      },
    ],
  );
  const key = eventKey ?? now.toISOString();
  await recordHealthEvent(
    c,
    id,
    'relogin_failed',
    reasons[reason],
    { eventKey: `login:${key}` },
    now,
  );
  if (reason === 'captcha' || reason === 'checkpoint')
    await recordHealthEvent(
      c,
      id,
      reason,
      reasons[reason],
      { eventKey: `${reason}:${key}` },
      now,
    );
}
export async function withSocialCredentialLogin(
  id: string,
  taskId: string,
  callback: (
    account: SocialSessionAccount,
    session: ResolvedSocialSession,
    credentials: ReturnType<typeof decryptSocialCredentials>,
    challenge: { waitForCode(kind: 'email' | 'sms'): Promise<string | null> },
  ) => Promise<SocialCredentialLoginResult>,
  now = new Date(),
): Promise<TaskOutcome> {
  const c = await sonarPool.connect();
  let locked = false;
  try {
    await c.query(
      "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
      [id],
    );
    locked = true;
    const row = await account(c, id);
    const {
      rows: [task],
    } = await c.query(
      "select payload,result,status from tasks where id=$1 and type='social.session.login' and payload->>'accountId'=$2",
      [taskId, id],
    );
    if (
      !task ||
      task.result?.credentialAttempted ||
      !['running', 'queued'].includes(task.status)
    )
      return {
        status: 'skipped',
        reasonCode: 'social_login_duplicate',
        reasonUk: 'Цю спробу входу вже виконано. Повторіть вхід вручну.',
      };
    const settings = await config(c);
    const day = now.toISOString().slice(0, 10);
    if (
      !row.settings.credentialsEncrypted ||
      row.settings.loginBlocked ||
      (task.payload.automatic &&
        (row.status === 'disabled' || row.settings.enabled === false)) ||
      (row.settings.loginAttemptDay === day &&
        Number(row.settings.loginAttemptCount) >= settings.daily)
    )
      return {
        status: 'skipped',
        reasonCode: 'social_login_limit',
        reasonUk:
          'Вхід недоступний: перевірте пароль, стан акаунта та денний ліміт.',
      };
    let credentials: ReturnType<typeof decryptSocialCredentials>;
    let session: ResolvedSocialSession;
    try {
      credentials = decryptSocialCredentials(
        row.settings.credentialsEncrypted,
        secret(),
      );
      if (row.settings.proxyFingerprintPending) {
        const proxy = socialSessionProxies()[Number(row.settings.proxyIndex)];
        if (proxy)
          row.settings.proxyFingerprint = socialProxyFingerprint(proxy);
      }
      row.settings.device ??= generateSocialDevice(row.channel);
      session = resolveSocialSession(row, secret(), undefined, true);
      session.persistStorageState = (state, device) =>
        persistSocialStorageState(c, id, state, device);
      session.persistDevice = async (device) => {
        await c.query(
          "update channel_accounts set settings=settings||jsonb_build_object('device',$2::jsonb) where id=$1",
          [id, JSON.stringify(device)],
        );
      };
    } catch {
      await finishFailure(c, id, 'login_failed', now, taskId);
      return {
        status: 'paused',
        reasonCode: 'social_login_configuration',
        reasonUk: reasons.login_failed,
      };
    }
    await c.query('begin');
    try {
      await c.query(
        "update channel_accounts set settings=(settings-'proxyFingerprintPending'-'loginCodeEncrypted'-'loginChallengeKind'-'loginChallengeExpiresAt')||$2::jsonb where id=$1",
        [
          id,
          {
            loginTaskId: taskId,
            loginRecoveryPending: false,
            loginAttemptDay: day,
            loginAttemptCount:
              row.settings.loginAttemptDay === day
                ? Number(row.settings.loginAttemptCount ?? 0) + 1
                : 1,
            device: row.settings.device,
            proxyFingerprint: row.settings.proxyFingerprint,
          },
        ],
      );
      await c.query(
        "update tasks set result=coalesce(result,'{}'::jsonb)||'{\"credentialAttempted\":true}'::jsonb where id=$1",
        [taskId],
      );
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    }
    const deadline = Date.now() + settings.timeout * 1000;
    const waitForCode = async (kind: 'email' | 'sms') => {
      if (Date.now() >= deadline) return null;
      await c.query(
        "update channel_accounts set status='paused',settings=(settings-'loginCodeEncrypted')||$2::jsonb where id=$1",
        [
          id,
          {
            loginChallengeKind: kind,
            loginChallengeExpiresAt: new Date(deadline).toISOString(),
            sessionStatus: 'invalid',
            sessionLossActive: true,
            sessionLostEventId: randomUUID(),
            sessionLostAt: new Date().toISOString(),
            sessionLostReasonUk:
              'Введіть код підтвердження у налаштуваннях каналу.',
            reasonUk: 'Введіть код підтвердження у налаштуваннях каналу.',
          },
        ],
      );
      await recordHealthEvent(
        c,
        id,
        'code_requested',
        'Введіть код підтвердження у налаштуваннях каналу.',
        { eventKey: `code:${taskId}:${kind}` },
      );
      await c.query(
        "update tasks set status='paused',reason_code='social_login_code_required',reason_uk='Введіть код підтвердження у налаштуваннях каналу.' where id=$1",
        [taskId],
      );
      while (Date.now() < deadline) {
        const {
          rows: [mailbox],
        } = await c.query(
          "with mailbox as (select id,settings->>'loginCodeEncrypted' as code from channel_accounts where id=$1 and settings->>'loginTaskId'=$2 and settings->>'loginCodeEncrypted' is not null for update) update channel_accounts a set settings=a.settings-'loginCodeEncrypted' from mailbox where a.id=mailbox.id returning mailbox.code",
          [id, taskId],
        );
        if (mailbox?.code) {
          await c.query(
            "update tasks set status='running',reason_code=null,reason_uk=null where id=$1",
            [taskId],
          );
          await c.query(
            "update channel_accounts set settings=settings-'loginChallengeKind'-'loginChallengeExpiresAt' where id=$1",
            [id],
          );
          return decryptSocialLoginCode(mailbox.code, secret());
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return null;
    };
    let result: SocialCredentialLoginResult;
    try {
      result = await callback(row, session, credentials, { waitForCode });
    } catch {
      result = { valid: false, reason: 'login_failed' };
    }
    if (result.valid) {
      await c.query(
        "update channel_accounts set status=case when settings->>'enabled'='false' then 'disabled' when settings->>'healthAutoPaused'='true' then 'paused' else 'active' end,settings=(settings-'loginCodeEncrypted'-'loginChallengeKind'-'loginChallengeExpiresAt'-'loginTaskId'-'loginShot')||$2::jsonb where id=$1",
        [
          id,
          {
            loginRecoveryPending: false,
            sessionStatus: 'valid',
            sessionLossActive: false,
            sessionCheckReason: null,
            reasonUk:
              row.settings.healthAutoPaused === true
                ? row.settings.reasonUk
                : null,
            checkedAt: new Date().toISOString(),
            loginAutoAttempted: false,
          },
        ],
      );
      await recordHealthEvent(
        c,
        id,
        'relogin_ok',
        'Вхід у соцмережу виконано.',
        { eventKey: `login:${taskId}` },
      );
      return {
        status: 'done',
        result: { valid: true, credentialAttempted: true },
      };
    }
    const reason =
      result.reason && Object.hasOwn(reasons, result.reason)
        ? result.reason
        : 'login_failed';
    await finishFailure(c, id, reason, new Date(), taskId);
    if (
      typeof result.screenshot === 'string' &&
      result.screenshot.length < 3_000_000
    )
      await c.query(
        "update channel_accounts set settings=settings||jsonb_build_object('loginShot',jsonb_build_object('at',now(),'jpeg',$2::text)) where id=$1",
        [id, result.screenshot],
      );
    return {
      status: 'paused',
      reasonCode: `social_login_${reason}`,
      reasonUk: reasons[reason],
      result: { valid: false, credentialAttempted: true },
    };
  } finally {
    if (locked) await releaseSocialFetchSession(c, id);
    c.release();
  }
}
/** Recover durable S1 intent; a released lock also proves a live login context was lost. */
export async function reconcileSocialCredentialLogins() {
  return transaction(async (c) => {
    const { rows } = await c.query(
      "select id,settings->>'loginTaskId' as task from channel_accounts where settings->>'loginTaskId' is not null or settings->>'loginRecoveryPending'='true'",
    );
    let count = 0;
    for (const row of rows) {
      const {
        rows: [lease],
      } = await c.query(
        "select pg_try_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
        [row.id],
      );
      if (!lease.locked) continue;
      const current = await account(c, row.id);
      if (!current.settings.loginTaskId) {
        if (current.settings.loginRecoveryPending === true) {
          if (await queueAutomaticSocialRelogin(c, row.id, new Date())) count++;
        }
        continue;
      }
      await finishFailure(c, row.id, 'code_expired', new Date(), row.task);
      await c.query(
        "update tasks set status='failed',finished_at=now(),reason_code='social_login_context_lost',reason_uk=$2 where id=$1 and status in ('running','paused')",
        [row.task, reasons.code_expired],
      );
      count++;
    }
    return count;
  });
}
