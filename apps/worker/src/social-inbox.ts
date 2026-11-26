import type {
  SocialInboxBatch,
  SocialInboxCheckpoint,
} from '@sonar/core/social-inbox';
import {
  nextSocialInboxFailureAt,
  nextSocialInboxPollAt,
} from '@sonar/core/social-inbox-schedule';
import {
  SocialProfileBusyError,
  resolveSocialSession,
  safeSocialSessionDiagnostic,
  SocialSendError,
  SocialSessionCheckError,
  socialSessionCheckReason,
  socialSessionCheckReasons,
  profileLockDiagnostic,
} from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import {
  emptySocialCheckpoint,
  persistSocialInboxBatch,
  reconcileSocialInbox,
} from '@sonar/db/social-inbox';
import {
  reserveSocialAction,
  socialSendPriority,
} from '@sonar/db/social-action';
import {
  releaseSocialFetchSession,
  prepareSocialSession,
  pauseSocialFetchSession,
  type SocialSessionAccount,
} from '@sonar/db/social-accounts';
import { boss, runTask, type TaskOutcome } from '@sonar/db/tasks';

export class SocialInboxAdapterError extends Error {
  constructor(
    public code: 'history_locked' | 'unsupported_dom' | 'missing_adapter',
    public reasonUk: string,
  ) {
    super(reasonUk);
  }
}
class SendPriorityYield extends SocialProfileBusyError {
  constructor(readonly outcome: TaskOutcome) {
    super();
  }
}
export type SocialInboxAccount = SocialSessionAccount & {
  beforeRead?: () => Promise<void>;
  session: ReturnType<typeof resolveSocialSession>;
};
const inboxStages = [
  'sync',
  'navigation',
  'http',
  'auth',
  'restore',
  'identity',
  'capture_auth',
  'actor',
  'persist',
] as const;
const inboxKinds = [
  'timeout',
  'network',
  'browser',
  'unknown_auth',
  'login_required',
  'cookies_invalid',
  'captcha',
  'checkpoint',
  'action_blocked',
  'rate_limit',
  'unsupported_dom',
  'history_locked',
  'missing_adapter',
  'proxy',
  'unexpected',
] as const;
function inboxFailureDetails(error: unknown) {
  const value = (error && typeof error === 'object' ? error : {}) as {
    stage?: unknown;
    errorKind?: unknown;
    code?: unknown;
    reason?: unknown;
    diagnostic?: { stage?: unknown };
  };
  const stageValue = value.stage ?? value.diagnostic?.stage ?? 'sync';
  const stage = inboxStages.includes(stageValue as (typeof inboxStages)[number])
    ? (stageValue as (typeof inboxStages)[number])
    : 'sync';
  const kindValue =
    error instanceof SocialSessionCheckError
      ? error.reason
      : error instanceof SocialInboxAdapterError
        ? error.code
        : error instanceof SocialSendError
          ? error.code === 'rate_limit'
            ? 'rate_limit'
            : socialSessionCheckReason(error)
          : (value.errorKind ?? value.code ?? value.reason ?? 'unexpected');
  const kind = inboxKinds.includes(kindValue as (typeof inboxKinds)[number])
    ? (kindValue as (typeof inboxKinds)[number])
    : 'unexpected';
  const stageUk: Record<(typeof inboxStages)[number], string> = {
    sync: 'синхронізація',
    navigation: 'відкриття сторінки',
    http: 'HTTP-відповідь',
    auth: 'перевірка сесії',
    restore: 'відновлення історії',
    identity: 'перевірка акаунта',
    capture_auth: 'перевірка під час читання',
    actor: 'перевірка відправника',
    persist: 'збереження порції',
  };
  const kindUk: Record<(typeof inboxKinds)[number], string> = {
    timeout: 'тайм-аут',
    network: 'мережа',
    browser: 'браузер',
    unknown_auth: 'сесію не підтверджено',
    login_required: 'потрібен вхід',
    cookies_invalid: 'некоректна сесія',
    captcha: 'CAPTCHA',
    checkpoint: 'перевірка особи',
    action_blocked: 'дію заблоковано',
    rate_limit: 'обмеження частоти',
    unsupported_dom: 'структура сторінки',
    history_locked: 'історія недоступна',
    missing_adapter: 'адаптер відсутній',
    proxy: 'проксі',
    unexpected: 'неочікувана помилка',
  };
  return { stage, kind, reasonUk: `${stageUk[stage]}: ${kindUk[kind]}.` };
}
/** Adapter must await persistBatch BEFORE scrolling/navigating. IDs must come from
 * observed provider evidence. complete means ALL available history since watermark
 * was traversed, with no PIN/missing-history warnings or unstable IDs. Never use
 * React IDs, text hashes or body/time matching. Resume anchors must be nonsecret.
 * Use socialSendBrowser.withPage for the isolated pinned account/proxy context. */
export interface SocialInboxAdapter {
  sync(
    account: SocialInboxAccount,
    checkpoint: SocialInboxCheckpoint,
    persistBatch: (batch: SocialInboxBatch) => Promise<void>,
  ): Promise<{
    complete: boolean;
    reason?: 'history_locked' | 'unsupported_dom';
    skipped?: string[];
  }>;
}
export async function runSocialInboxSync(
  input: { accountId: string },
  adapter?: SocialInboxAdapter,
  now = new Date(),
  taskId?: string,
): Promise<TaskOutcome> {
  if (!adapter)
    return {
      status: 'skipped',
      reasonCode: 'social_inbox_missing_adapter',
      reasonUk: 'Адаптер вхідних соцмереж ще не підключено.',
    };
  const c = await sonarPool.connect();
  let locked = false;
  let manual = false;
  let retainReservation = false;
  const pending: { writing: Promise<unknown> | null } = { writing: null };
  let accepting = true;
  try {
    const {
      rows: [lock],
    } = await c.query(
      "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
      [input.accountId],
    );
    if (!lock.locked) {
      const {
        rows: [busySetting],
      } = await c.query(
        "select value from settings where key='social.profile.busy_retry_seconds'",
      );
      const retrySeconds = Number(busySetting?.value);
      if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1)
        throw new Error('Invalid social.profile.busy_retry_seconds');
      return {
        status: 'deferred',
        runAt: new Date(now.getTime() + retrySeconds * 1000),
        reasonCode: 'social_profile_busy',
        reasonUk: 'Браузер акаунта зайнятий.',
        result: profileLockDiagnostic('account_operation'),
      };
    }
    locked = true;
    const beforeRead = async () => {
      const priority = await socialSendPriority(c, input.accountId);
      if (priority) throw new SendPriorityYield(priority);
    };
    await beforeRead();
    const {
      rows: [account],
    } = await c.query<
      SocialSessionAccount & { status: string; owner_id: string | null }
    >(
      "select id,channel,settings,status,owner_id from channel_accounts where id=$1 and channel in ('instagram','facebook','linkedin')",
      [input.accountId],
    );
    if (
      !account ||
      account.status !== 'active' ||
      account.settings.enabled === false ||
      account.settings.sessionStatus !== 'valid'
    )
      return {
        status: 'paused',
        reasonCode: 'social_account_inactive',
        reasonUk: 'Увімкніть акаунт із підтвердженою сесією.',
      };
    if (taskId) {
      const {
        rows: [receipt],
      } = await c.query(
        `select t.payload->>'mode' as mode, (t.subject_type='channel_account' and t.subject_id=$2
        and t.payload->>'requestedBy'=$3 and $4::boolean
        and exists(select 1 from activity_log l where l.action='social.inbox.manual.queued'
          and l.entity_type='channel_account' and l.entity_id=$2 and l.user_id::text=$3 and l.details->>'taskId'=t.id::text)) as trusted
        from tasks t where t.id=$1 and t.type='social.inbox.sync' and t.status in ('queued','running') and t.payload->>'accountId'=$2`,
        [
          taskId,
          account.id,
          account.owner_id,
          ['instagram', 'facebook'].includes(account.channel),
        ],
      );
      manual = receipt?.mode === 'manual' && receipt.trusted === true;
      if (receipt?.mode === 'manual' && !manual)
        return {
          status: 'paused',
          reasonCode: 'social_inbox_manual_unauthorized',
          reasonUk:
            'Дозвіл власника на разову синхронізацію недійсний. Власник має запустити її з акаунта повторно.',
        };
    }
    const { rows: settings } = await c.query(
      "select key,value from settings where key in ('social.inbox.enabled','social.inbox.poll_seconds','social.inbox.daily_limit','social.inbox.max_threads','social.inbox.max_messages','social.inbox.quiet_hours','social.inbox.timezone','social.inbox.failure_backoff_base_seconds','social.inbox.failure_backoff_max_seconds','social.inbox.facebook.enabled','social.inbox.instagram.enabled','social.inbox.linkedin.enabled')",
    );
    const config = Object.fromEntries(
      settings.map((row) => [row.key, row.value]),
    );
    if (
      !manual &&
      (config['social.inbox.enabled'] !== true ||
        config[`social.inbox.${account.channel}.enabled`] !== true ||
        account.settings.inboxPollingEnabled !== true)
    )
      return {
        status: 'skipped',
        reasonCode: 'social_inbox_disabled',
        reasonUk: 'Синхронізацію вхідних соцмереж вимкнено.',
      };
    const session = await prepareSocialSession(c, account);
    const poll = Number(config['social.inbox.poll_seconds']);
    const limit = Number(config['social.inbox.daily_limit']);
    const maxThreads = Number(config['social.inbox.max_threads']);
    const maxMessages = Number(config['social.inbox.max_messages']);
    if (
      !Number.isSafeInteger(poll) ||
      poll < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(maxThreads) ||
      maxThreads < 1 ||
      !Number.isSafeInteger(maxMessages) ||
      maxMessages < 1
    )
      return {
        status: 'paused',
        reasonCode: 'social_inbox_settings_invalid',
        reasonUk:
          'Налаштуйте інтервал та окремий денний ліміт синхронізації соцмереж.',
      };
    const failureBase = Number(
      config['social.inbox.failure_backoff_base_seconds'],
    );
    const failureMax = Number(
      config['social.inbox.failure_backoff_max_seconds'],
    );
    if (
      !Number.isSafeInteger(failureBase) ||
      failureBase < 1 ||
      !Number.isSafeInteger(failureMax) ||
      failureMax < failureBase
    )
      return {
        status: 'paused',
        reasonCode: 'social_inbox_settings_invalid',
        reasonUk: 'Перевірте відступ повтору синхронізації вхідних.',
      };
    const quietHours = String(config['social.inbox.quiet_hours']);
    let nextPollAt: string;
    try {
      nextPollAt = nextSocialInboxPollAt(
        now,
        poll,
        quietHours,
        undefined,
        String(config['social.inbox.timezone'] ?? 'Europe/Kyiv'),
      ).toISOString();
    } catch {
      return {
        status: 'paused',
        reasonCode: 'social_inbox_settings_invalid',
        reasonUk: 'Перевірте інтервал та тихі години опитування вхідних.',
      };
    }
    await c.query('begin');
    const resumed = taskId
      ? await c.query(
          "select 1 from tasks where id=$1 and payload->>'inboxActionReserved'='true'",
          [taskId],
        )
      : null;
    const runAt = resumed?.rows.length
      ? null
      : await reserveSocialAction(c, account.id, 'sync', now, limit);
    if (!runAt && taskId && !resumed?.rows.length)
      await c.query(
        'update tasks set payload=payload||\'{"inboxActionReserved":true}\'::jsonb where id=$1',
        [taskId],
      );
    await c.query('commit');
    if (runAt) {
      if (!manual)
        await c.query(
          "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||jsonb_build_object('nextPollAt',$2::text)) where id=$1",
          [account.id, runAt.toISOString()],
        );
      return {
        status: 'deferred',
        runAt,
        reasonCode: 'social_action_gate',
        reasonUk:
          'Синхронізація після спільної паузи або окремого денного ліміту.',
      };
    }
    const checkpoint = {
      ...emptySocialCheckpoint(),
      ...(account.settings.inboxSync as Partial<SocialInboxCheckpoint>),
    } as SocialInboxCheckpoint;
    checkpoint.cycleStartedAt ??= now.toISOString();
    await c.query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',$2::jsonb) where id=$1",
      [
        account.id,
        JSON.stringify({
          ...(account.settings.inboxSync as Partial<SocialInboxCheckpoint>),
          ...checkpoint,
          complete: false,
          ...(!manual ? { nextPollAt } : {}),
        }),
      ],
    );
    let created = 0;
    const conflicts: string[] = [];
    const result = await adapter.sync(
      {
        ...account,
        beforeRead,
        session,
        settings: {
          ...account.settings,
          inboxMaxThreads: maxThreads,
          inboxMaxMessages: maxMessages,
        },
      },
      checkpoint,
      async (batch) => {
        if (!accepting || pending.writing)
          throw new Error('Adapter must await each persisted batch');
        const save = persistSocialInboxBatch(
          account.id,
          account.channel,
          batch,
        );
        pending.writing = save;
        try {
          const saved = await save;
          created += saved.created;
          conflicts.push(...saved.conflicts);
          for (const message of batch.messages) {
            const cursor = ((checkpoint.threadCursors ??= {})[
              message.threadId
            ] ??= {});
            if (message.occurredAt) {
              if (
                !cursor.lastMessageAt ||
                Date.parse(message.occurredAt) >
                  Date.parse(cursor.lastMessageAt)
              ) {
                cursor.lastMessageAt = message.occurredAt;
                cursor.lastMessageIds = [message.externalMessageId];
              } else if (message.occurredAt === cursor.lastMessageAt) {
                cursor.lastMessageIds = [
                  ...new Set([
                    ...(cursor.lastMessageIds ?? []),
                    message.externalMessageId,
                  ]),
                ].slice(-100);
              }
            } else {
              cursor.lastMessageId = message.externalMessageId;
            }
          }
          await c.query(
            "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||jsonb_build_object('threadCursors',$2::jsonb)) where id=$1",
            [account.id, JSON.stringify(checkpoint.threadCursors ?? {})],
          );
        } finally {
          pending.writing = null;
        }
        await beforeRead();
      },
    );
    accepting = false;
    await pending.writing;
    const complete =
      result.complete &&
      !result.reason &&
      !(result.skipped?.length ?? 0) &&
      conflicts.length === 0;
    const priorFailures = Number(
      (account.settings.inboxSync as { failureCount?: unknown } | undefined)
        ?.failureCount,
    );
    // Coverage notes that every run carries (pagination, archive, empty request
    // lists) make a run "incomplete" for the UI but are not failures: they must
    // not push the next poll out with the failure back-off.
    const informationalSkips = new Set([
      'pagination_unverified',
      'archived_folder_unverified',
      'requests_empty_or_unverified',
      'requests_preview_only',
      // Instagram always emits ancillary GraphQL (unread counts etc.) that the
      // capture ignores on purpose; it says nothing about mailbox coverage.
      'unsupported_query_ignored',
    ]);
    // "unsupported_dom" is the standing marker of a pass that cannot prove the
    // whole history; with only coverage notes it is not a failure either.
    const healthy =
      (!result.reason || result.reason === 'unsupported_dom') &&
      conflicts.length === 0 &&
      (result.skipped ?? []).every((reason) => informationalSkips.has(reason));
    const failureCount = healthy
      ? 0
      : Math.max(0, Number.isSafeInteger(priorFailures) ? priorFailures : 0) +
        1;
    const scheduledPollAt = healthy
      ? nextPollAt
      : nextSocialInboxFailureAt(
          now,
          poll,
          failureCount,
          failureBase,
          failureMax,
          quietHours,
          undefined,
          String(config['social.inbox.timezone'] ?? 'Europe/Kyiv'),
        ).toISOString();
    await c.query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||$2::jsonb) where id=$1",
      [
        account.id,
        JSON.stringify({
          ...(!manual ? { nextPollAt: scheduledPollAt } : {}),
          checkedAt: now.toISOString(),
          errorUk: null,
          complete,
          failureCount,
          created,
          reason: result.reason ?? null,
          ...(!complete
            ? {
                lastFailure: {
                  at: now.toISOString(),
                  stage: result.reason ? 'sync' : 'persist',
                  kind: result.reason ?? 'incomplete',
                  skipped: (result.skipped ?? []).slice(0, 12),
                },
              }
            : { lastFailure: null }),
          ...(complete
            ? {
                watermark: checkpoint.cycleStartedAt,
                resumeAnchor: null,
                cycleStartedAt: null,
              }
            : {}),
        }),
      ],
    );
    return {
      status: 'done',
      result: {
        created,
        mode: manual ? 'manual' : 'automatic',
        conflicts,
        complete,
        reason: result.reason ?? null,
        skipped: result.skipped ?? [],
      },
    };
  } catch (error) {
    accepting = false;
    await pending.writing?.catch(() => {});
    await c.query('rollback');
    if (error instanceof SendPriorityYield) {
      retainReservation = true;
      return error.outcome;
    }
    if (error instanceof SocialProfileBusyError) {
      retainReservation = true;
      const {
        rows: [busySetting],
      } = await c.query(
        "select value from settings where key='social.profile.busy_retry_seconds'",
      );
      const retrySeconds = Number(busySetting?.value);
      if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1)
        throw new Error('Invalid social.profile.busy_retry_seconds');
      return {
        status: 'deferred',
        runAt: new Date(now.getTime() + retrySeconds * 1000),
        reasonCode: 'social_profile_busy',
        reasonUk: 'Браузер акаунта зайнятий.',
        result: profileLockDiagnostic('browser_lease'),
      };
    }
    if (error instanceof SocialSendError) {
      const reason =
        error instanceof SocialSessionCheckError
          ? error.reason
          : error.code === 'rate_limit'
            ? 'rate_limit'
            : socialSessionCheckReason(error);

      const diagnostic =
        error instanceof SocialSessionCheckError
          ? safeSocialSessionDiagnostic(error.diagnostic)
          : undefined;
      const authSignal =
        error instanceof SocialSessionCheckError &&
        [
          'login_required',
          'cookies_invalid',
          'captcha',
          'checkpoint',
          'action_blocked',
        ].includes(reason);
      if (authSignal)
        await pauseSocialFetchSession(
          c,
          input.accountId,
          reason,
          now,
          taskId ? `inbox:${taskId}` : undefined,
        );
      if (!manual && authSignal) {
        await c.query(
          "update channel_accounts set settings=settings||jsonb_build_object('inboxPollingEnabled',false,'inboxSync',coalesce(settings->'inboxSync','{}'::jsonb)||jsonb_build_object('checkedAt',$2::text,'errorUk',$3::text)) where id=$1 and channel in ('instagram','facebook')",
          [
            input.accountId,
            now.toISOString(),
            socialSessionCheckReasons[reason],
          ],
        );
      }
      if (authSignal)
        return {
          status: 'paused',
          reasonCode: `social_inbox_${reason}`,
          reasonUk: socialSessionCheckReasons[reason],
          ...(diagnostic ? { result: { diagnostic } } : {}),
        };
    }
    const details = inboxFailureDetails(error);
    const { rows: settingRows } = await c.query(
      "select key,value from settings where key in ('social.inbox.poll_seconds','social.inbox.quiet_hours','social.inbox.timezone','social.inbox.failure_backoff_base_seconds','social.inbox.failure_backoff_max_seconds')",
    );
    const failureConfig = Object.fromEntries(
      settingRows.map((setting) => [setting.key, setting.value]),
    );
    const {
      rows: [syncState],
    } = await c.query(
      "select settings->'inboxSync' as state from channel_accounts where id=$1",
      [input.accountId],
    );
    const previousFailureCount = Number(syncState?.state?.failureCount);
    const nextFailureCount =
      Math.max(
        0,
        Number.isSafeInteger(previousFailureCount) ? previousFailureCount : 0,
      ) + 1;
    const failedAt = nextSocialInboxFailureAt(
      now,
      Number(failureConfig['social.inbox.poll_seconds']),
      nextFailureCount,
      Number(failureConfig['social.inbox.failure_backoff_base_seconds']),
      Number(failureConfig['social.inbox.failure_backoff_max_seconds']),
      String(failureConfig['social.inbox.quiet_hours'] ?? '00:00-07:00'),
      undefined,
      String(failureConfig['social.inbox.timezone'] ?? 'Europe/Kyiv'),
    );
    await c.query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||$2::jsonb) where id=$1",
      [
        input.accountId,
        JSON.stringify({
          failureCount: nextFailureCount,
          nextPollAt: failedAt.toISOString(),
          checkedAt: now.toISOString(),
          lastFailure: {
            at: now.toISOString(),
            stage: details.stage,
            kind: details.kind,
          },
          errorUk: `Не вдалося синхронізувати соцмережу (${details.reasonUk}). Збережені порції залишено; повтор заплановано.`,
          complete: false,
        }),
      ],
    );
    return {
      status: 'failed',
      reasonCode: `social_inbox_${details.stage}_${details.kind}`,
      reasonUk: `Не вдалося синхронізувати соцмережу (${details.reasonUk}). Збережені порції залишено; повтор заплановано.`,
      result: { stage: details.stage, kind: details.kind },
    };
  } finally {
    try {
      if (taskId && locked && !retainReservation)
        await c.query(
          "update tasks set payload=payload-'inboxActionReserved' where id=$1",
          [taskId],
        );
    } finally {
      try {
        if (locked) await releaseSocialFetchSession(c, input.accountId);
      } finally {
        c.release();
      }
    }
  }
}

export async function registerSocialInboxTasks(adapter?: SocialInboxAdapter) {
  await boss.createQueue('social.inbox.sync');
  await runTask(
    'social.inbox.sync',
    (payload, taskId) =>
      runSocialInboxSync(
        payload as { accountId: string },
        adapter,
        new Date(),
        taskId,
      ),
    async (payload) => {
      if (adapter && (payload as { mode?: unknown }).mode !== 'manual')
        await reconcileSocialInbox();
    },
  );
  // Register the explicit unsupported handler, but never activate polling without
  // a verified real adapter. Startup + scheduler repair absent account jobs.
  if (!adapter) return;
  await boss.createQueue('social.inbox.reconcile');
  await boss.work('social.inbox.reconcile', async () => {
    await reconcileSocialInbox();
  });
  await boss.schedule('social.inbox.reconcile', '* * * * *');
  await reconcileSocialInbox();
}
