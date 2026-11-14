import type {
  SocialInboxBatch,
  SocialInboxCheckpoint,
} from '@sonar/core/social-inbox';
import {
  resolveSocialSession,
  SocialSendError,
  SocialSessionCheckError,
  socialSessionCheckReason,
  socialSessionCheckReasons,
} from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import {
  emptySocialCheckpoint,
  persistSocialInboxBatch,
  reconcileSocialInbox,
} from '@sonar/db/social-inbox';
import { reserveSocialAction } from '@sonar/db/social-action';
import {
  releaseSocialFetchSession,
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
export type SocialInboxAccount = SocialSessionAccount & {
  session: ReturnType<typeof resolveSocialSession>;
};
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
  const pending: { writing: Promise<unknown> | null } = { writing: null };
  let accepting = true;
  try {
    const {
      rows: [lock],
    } = await c.query(
      "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
      [input.accountId],
    );
    if (!lock.locked)
      return {
        status: 'deferred',
        runAt: new Date(now.getTime() + 1000),
        reasonCode: 'social_account_busy',
        reasonUk: 'Акаунт виконує іншу дію. Синхронізація після звільнення.',
      };
    locked = true;
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
    let manual = false;
    if (taskId) {
      const {
        rows: [receipt],
      } = await c.query(
        `select t.payload->>'mode' as mode, (t.subject_type='channel_account' and t.subject_id=$2
        and t.payload->>'requestedBy'=$3 and $4::boolean
        and exists(select 1 from activity_log l where l.action='social.inbox.manual.queued'
          and l.entity_type='channel_account' and l.entity_id=$2 and l.user_id::text=$3 and l.details->>'taskId'=t.id::text)) as trusted
        from tasks t where t.id=$1 and t.type='social.inbox.sync' and t.status in ('queued','running') and t.payload->>'accountId'=$2`,
        [taskId, account.id, account.owner_id, account.channel === 'instagram'],
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
      "select key,value from settings where key in ('social.inbox.enabled','social.inbox.poll_seconds','social.inbox.daily_limit')",
    );
    const config = Object.fromEntries(
      settings.map((row) => [row.key, row.value]),
    );
    if (config['social.inbox.enabled'] !== true && !manual)
      return {
        status: 'skipped',
        reasonCode: 'social_inbox_disabled',
        reasonUk: 'Синхронізацію вхідних соцмереж вимкнено.',
      };
    const session = resolveSocialSession(account);
    const poll = Number(config['social.inbox.poll_seconds']);
    const limit = Number(config['social.inbox.daily_limit']);
    if (
      !Number.isSafeInteger(poll) ||
      poll < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      return {
        status: 'paused',
        reasonCode: 'social_inbox_settings_invalid',
        reasonUk:
          'Налаштуйте інтервал та окремий денний ліміт синхронізації соцмереж.',
      };
    await c.query('begin');
    const runAt = await reserveSocialAction(c, account.id, 'sync', now, limit);
    await c.query('commit');
    if (runAt)
      return {
        status: 'deferred',
        runAt,
        reasonCode: 'social_action_gate',
        reasonUk:
          'Синхронізація після спільної паузи або окремого денного ліміту.',
      };
    const checkpoint = {
      ...emptySocialCheckpoint(),
      ...(account.settings.inboxSync as Partial<SocialInboxCheckpoint>),
    } as SocialInboxCheckpoint;
    checkpoint.cycleStartedAt ??= now.toISOString();
    const nextPollAt = new Date(now.getTime() + poll * 1000).toISOString();
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
      { ...account, session },
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
        } finally {
          pending.writing = null;
        }
      },
    );
    accepting = false;
    await pending.writing;
    const complete =
      result.complete && !result.reason && conflicts.length === 0;
    await c.query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||$2::jsonb) where id=$1",
      [
        account.id,
        JSON.stringify({
          ...(!manual ? { nextPollAt } : {}),
          complete,
          reason: result.reason ?? null,
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
    if (error instanceof SocialInboxAdapterError)
      return {
        status: 'paused',
        reasonCode: `social_inbox_${error.code}`,
        reasonUk: error.reasonUk,
      };
    if (error instanceof SocialSendError) {
      const reason =
        error instanceof SocialSessionCheckError
          ? error.reason
          : error.code === 'rate_limit'
            ? 'rate_limit'
            : socialSessionCheckReason(error);
      const invalid = ['login_required', 'cookies_invalid'].includes(reason);
      if (error.code === 'session_invalid' || error.code === 'rate_limit')
        await c.query(
          "update channel_accounts set status='paused',settings=settings||$2::jsonb where id=$1",
          [
            input.accountId,
            JSON.stringify({
              reasonUk: socialSessionCheckReasons[reason],
              sessionCheckReason: reason,
              ...(invalid ? { sessionStatus: 'invalid' } : {}),
            }),
          ],
        );
      return {
        status: 'paused',
        reasonCode: `social_inbox_${reason}`,
        reasonUk: socialSessionCheckReasons[reason],
      };
    }
    return {
      status: 'failed',
      reasonCode: 'social_inbox_failed',
      reasonUk:
        'Не вдалося синхронізувати соцмережу. Збережені порції залишено; повторіть із точки продовження.',
    };
  } finally {
    if (locked) await releaseSocialFetchSession(c, input.accountId);
    c.release();
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
