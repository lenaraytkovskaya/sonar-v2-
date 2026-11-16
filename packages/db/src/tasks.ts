import { prozorroCode } from '@sonar/core';
import { enqueueCompanyScores } from './scoring.js';
import { randomUUID } from 'node:crypto';
import { PgBoss, type Db } from 'pg-boss';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';
export const queueName = 'system.registry_ping';
// Producers use an existing schema; only the worker starts pg-boss maintenance.
export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  migrate: false,
});
boss.on('error', (error) => console.error('queue error', error.message));
const producer = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  migrate: false,
  supervise: false,
  schedule: false,
});
producer.on('error', (error) =>
  console.error('queue producer error', error.message),
);
let producerStarted: Promise<unknown> | undefined;
export async function closeTaskQueue() {
  await Promise.all([
    boss.stop({ graceful: true, timeout: 20000 }),
    producer.stop({ graceful: true, timeout: 20000 }),
  ]);
}

const dbFor = (client: PoolClient): Db => ({
  executeSql: (sql, values) => client.query(sql, values),
});
export async function logActivity(
  action: string,
  entityType: string,
  entityId: string | null,
  userId: string | null = null,
  details: object = {},
  client: Pick<PoolClient, 'query'> = sonarPool,
) {
  await client.query(
    'insert into activity_log(action,entity_type,entity_id,user_id,details) values($1,$2,$3,$4,$5)',
    [action, entityType, entityId, userId, details],
  );
}
async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const value = await fn(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
async function dispatch(
  client: PoolClient,
  id: string,
  type: string,
  startAfter?: Date,
) {
  const { rows } = await client.query(
    'select value from settings where key=$1',
    [`tasks.${type}`],
  );
  const config = rows[0]?.value;
  if (!config) throw new Error(`Missing task settings: ${type}`);
  await (producerStarted ??= producer.start().catch((error) => {
    producerStarted = undefined;
    throw error;
  }));
  const { rows: identity } = ['prozorro.company', 'google.company'].includes(
    type,
  )
    ? await client.query('select payload from tasks where id=$1', [id])
    : { rows: [] };
  await producer.send(
    type,
    {
      taskId: id,
      ...(['prozorro.company', 'google.company'].includes(type)
        ? {
            version:
              type === 'google.company'
                ? String(identity[0]?.payload.resolveVersion ?? 0)
                : (identity[0]?.payload.version ?? null),
          }
        : {}),
    },
    {
      db: dbFor(client),
      startAfter,
      retryLimit: config.retryLimit,
      retryDelay: config.retryDelay,
      expireInSeconds: config.expireInSeconds,
    },
  );
}
export async function enqueueTask(
  type: string,
  key: string,
  payload: object = {},
  existingClient?: PoolClient,
  startAfter?: Date,
) {
  const save = async (client: PoolClient) => {
    const { rows } = await client.query(
      'insert into tasks(type,idempotency_key,payload) values($1,$2,$3) on conflict(idempotency_key) do nothing returning id',
      [type, key, payload],
    );
    let id = rows[0]?.id;
    if (!id && type === 'company.analyze') {
      const { rows: resumed } = await client.query(
        `update tasks t set status='queued',reason_code=null,reason_uk=null,finished_at=null
        where idempotency_key=$1 and type='company.analyze' and status='skipped' and reason_code='score_below_threshold'
        and coalesce(result->>'billingPending','false')<>'true' and not exists(select 1 from spend_events where task_id=t.id)
        and exists(select 1 from company_scores s where s.company_id=(t.payload->>'companyId')::uuid and s.campaign_id=(t.payload->>'campaignId')::uuid
          and s.score >= (select min_score from campaigns where id=s.campaign_id)) returning id`,
        [key],
      );
      id = resumed[0]?.id;
    }
    if (!id && type === 'message.send') {
      const { rows: resumed } = await client.query(
        "update tasks set status='queued',reason_code=null,reason_uk=null,finished_at=null where idempotency_key=$1 and type='message.send' and status in ('paused','skipped') and exists(select 1 from messages m where m.id=(tasks.payload->>'messageId')::uuid and m.status='queued') returning id",
        [key],
      );
      id = resumed[0]?.id;
    }
    if (id) await dispatch(client, id, type, startAfter);
    return id ?? null;
  };
  return existingClient ? save(existingClient) : transaction(save);
}
export async function enqueueSiteScan(
  companyId: string,
  userId: string | null,
  existingClient?: PoolClient,
  requestKey?: string,
) {
  const save = async (client: PoolClient) => {
    const {
      rows: [company],
    } = await client.query(
      'select website from companies where id=$1 for share',
      [companyId],
    );
    if (!company?.website) return null;
    const day = new Date().toISOString().slice(0, 10);
    let key = `site.scan:${companyId}:${day}`;
    // Automatic runs scan once a day; a person pressing the button again after the
    // previous scan finished gets a fresh scan instead of the old result.
    if (userId && !requestKey) {
      const {
        rows: [latest],
      } = await client.query(
        "select idempotency_key,status from tasks where type='site.scan' and idempotency_key like $1 order by created_at desc limit 1",
        [`${key}%`],
      );
      if (latest && ['done', 'skipped', 'failed'].includes(latest.status))
        key = `${key}:${Date.now()}`;
      else if (latest) key = latest.idempotency_key;
    }
    key = requestKey ?? key;
    const created = await enqueueTask(
      'site.scan',
      key,
      { companyId, website: company.website },
      client,
    );
    if (created) {
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [created, companyId],
      );
      await logActivity(
        'site.scan.queued',
        'company',
        companyId,
        userId,
        { taskId: created },
        client,
      );
    }
    const {
      rows: [task],
    } = await client.query(
      'select id,status from tasks where idempotency_key=$1',
      [key],
    );
    return { ...task, created: !!created };
  };
  return existingClient ? save(existingClient) : transaction(save);
}
// Registry lookups are cheap and local; one per company per day is enough.
export async function enqueueRegistryMatch(
  companyId: string,
  userId: string | null,
) {
  return transaction(async (client) => {
    const day = new Date().toISOString().slice(0, 10);
    const key = `registry.match:${companyId}:${day}`;
    const created = await enqueueTask(
      'registry.match',
      key,
      { companyId },
      client,
    );
    if (created) {
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [created, companyId],
      );
      await logActivity(
        'registry.match.queued',
        'company',
        companyId,
        userId,
        { taskId: created },
        client,
      );
    }
    const {
      rows: [task],
    } = await client.query(
      'select id,status from tasks where idempotency_key=$1',
      [key],
    );
    return { ...task, created: !!created };
  });
}
export async function retryTask(
  id: string,
  userId: string,
  expectedSocialVersion?: number,
) {
  return transaction(async (client) => {
    const {
      rows: [identity],
    } = await client.query('select type,payload from tasks where id=$1', [id]);
    if (identity?.type === 'prozorro.company')
      return (
        await enqueueProzorroCompany(
          identity.payload.companyId,
          userId,
          client,
          { taskId: id, retry: true },
        )
      ).created;
    if (identity?.type === 'google.company') {
      const {
        rows: [lease],
      } = await client.query(
        'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked',
        [`google.company:${id}`],
      );
      if (!lease.locked) return false;
    }
    // Match reconciler lock ordering: orchestration lock before task row locks.
    if (identity?.type === 'social.inbox.sync')
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('social-inbox-reconcile',0))",
      );
    const {
      rows: [original],
    } = await client.query('select * from tasks where id=$1 for update', [id]);
    if (
      !original ||
      original.result?.billingPending ||
      original.type === 'social.request' ||
      original.type === 'google.resolve' ||
      original.type.startsWith('whatsapp.account.')
    )
      return false;
    if (original.type === 'social.inbox.sync') {
      if (original.status === 'done') return false;
      if (original.payload.mode === 'manual') {
        const {
          rows: [owned],
        } = await client.query(
          "select id from channel_accounts where id=$1 and owner_id=$2 and channel='instagram' and status='active' and settings->>'sessionStatus'='valid' and coalesce(settings->>'enabled','true')<>'false'",
          [original.payload.accountId, userId],
        );
        if (!owned || original.payload.requestedBy !== userId) return false;
        if (!['queued', 'running'].includes(original.status)) {
          const {
            rows: [closing],
          } = await client.query(
            "select id from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1 and state in ('created','retry','active') limit 1",
            [id],
          );
          if (closing) return false;
        }
      }
      const {
        rows: [active],
      } = await client.query(
        "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running') limit 1",
        [original.payload.accountId],
      );
      if (active) {
        if (active.id !== id) {
          await client.query(
            "update tasks set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('retryTaskId',$2::text) where id=$1",
            [id, active.id],
          );
          await logActivity(
            'task.retry',
            'task',
            id,
            userId,
            { activeTaskId: active.id },
            client,
          );
        }
        return true;
      }
      await client.query(
        "update tasks set result=result-'retryTaskId' where id=$1 and result ? 'retryTaskId'",
        [id],
      );
    }
    if (original.type === 'google.request') {
      const {
        rows: [parent],
      } = await client.query(
        "update tasks set status='queued',reason_code=null,reason_uk=null,finished_at=null where type='google.batch' and payload->>'batchId'=$1 and status in ('paused','failed','skipped') returning id,type",
        [original.batch_id],
      );
      if (!parent) return false;
      await dispatch(client, parent.id, parent.type);
      await logActivity(
        'task.retry',
        'task',
        id,
        userId,
        { parentId: parent.id },
        client,
      );
      return true;
    }
    if (original.type === 'social.fetch') {
      if (!['failed', 'paused', 'skipped'].includes(original.status))
        return false;
      if (
        expectedSocialVersion !== undefined &&
        (original.payload.requestVersion ?? 0) !== expectedSocialVersion
      )
        return false;
      const { prepareSocialRetry } = await import('./social.js');
      if (!(await prepareSocialRetry(client, original))) return false;
    }
    const { rows: settled } = await client.query(
      "select id from spend_events where task_id=$1 and (meta ? 'error' or meta ? 'reconciliation')",
      [id],
    );
    if (
      original.type === 'company.analyze' &&
      settled.length &&
      ['failed', 'paused'].includes(original.status)
    ) {
      if (original.result?.retryTaskId) return false;
      const {
        rows: [spent],
      } = await client.query(
        'select coalesce(sum(cost_usd),0)::float8 as cost from spend_events where task_id=$1',
        [id],
      );
      const { analysisPrompt: _oldPrompt, ...payload } = original.payload;
      void _oldPrompt;
      const retryId = await enqueueTask(
        original.type,
        `${original.idempotency_key}:retry:${randomUUID()}`,
        {
          ...payload,
          analysisSpentUsd:
            Number(original.payload.analysisSpentUsd ?? 0) + Number(spent.cost),
        },
        client,
      );
      if (!retryId) return false;
      await client.query(
        'update tasks set subject_type=$2,subject_id=$3 where id=$1',
        [retryId, original.subject_type, original.subject_id],
      );
      await client.query(
        "update tasks set dismissed_at=now(),result=coalesce(result,'{}'::jsonb)||jsonb_build_object('retryTaskId',$2::text) where id=$1",
        [id, retryId],
      );
      await logActivity(
        'task.retry',
        'task',
        id,
        userId,
        { retryTaskId: retryId },
        client,
      );
      return true;
    }
    if (original.type === 'google.company') {
      if (
        !['failed', 'paused', 'skipped'].includes(original.status) ||
        original.result?.retryTaskId
      )
        return false;
      if (settled.length) {
        // A known failure/reconciliation is immutable accounting evidence. A new
        // queued task is a new budgeted attempt, linked back to the saved source.
        const nextId = await enqueueTask(
          original.type,
          `${original.idempotency_key}:retry`,
          original.payload,
          client,
        );
        if (!nextId) return false;
        await client.query(
          'update tasks set subject_type=$2,subject_id=$3 where id=$1',
          [nextId, original.subject_type, original.subject_id],
        );
        await client.query(
          "update tasks set dismissed_at=now(),result=coalesce(result,'{}'::jsonb)||jsonb_build_object('retryTaskId',$2::text) where id=$1",
          [id, nextId],
        );
        await logActivity(
          'task.retry',
          'task',
          id,
          userId,
          { retryTaskId: nextId },
          client,
        );
        return true;
      }
      const {
        rows: [receipt],
      } = await client.query('select meta from spend_events where task_id=$1', [
        id,
      ]);
      if (receipt && !receipt.meta?.response) return false;
      if (!receipt && !original.payload.placeId)
        await client.query(
          "update tasks set payload=jsonb_set(payload,'{resolveVersion}',to_jsonb($2::int)) where id=$1",
          [id, (original.payload.resolveVersion ?? 0) + 1],
        );
      // No receipt, or a cached success after a persistence error: safely reuse
      // this attempt without another charge for an already successful response.
    }
    if (
      original.type === 'ai.assist' &&
      settled.length &&
      ['failed', 'paused'].includes(original.status)
    ) {
      await enqueueTask(
        original.type,
        `${original.idempotency_key}:retry:${randomUUID()}`,
        original.payload,
        client,
      );
      await client.query('update tasks set dismissed_at=now() where id=$1', [
        id,
      ]);
      await logActivity('task.retry', 'task', id, userId, {}, client);
      return true;
    }
    const { rows } = await client.query(
      "update tasks set status='queued', reason_code=null, reason_uk=null, finished_at=null where id=$1 and type<>'google.request' and status in ('failed','paused','skipped') returning type",
      [id],
    );
    if (!rows[0]) return false;
    await dispatch(client, id, rows[0].type);
    await logActivity('task.retry', 'task', id, userId, {}, client);
    return true;
  });
}
export class TaskFailure extends Error {
  constructor(
    public code: string,
    public reasonUk: string,
  ) {
    super(code);
  }
}
export type TaskOutcome =
  | { status: 'done'; result: object }
  | {
      status: 'skipped' | 'paused' | 'failed';
      result?: object;
      reasonCode: string;
      reasonUk: string;
    }
  | {
      status: 'deferred';
      runAt: Date;
      reasonCode: string;
      reasonUk: string;
      result?: object;
    };
export async function executeTask(
  handler: () => Promise<TaskOutcome>,
  save: (
    state: string,
    result?: object,
    code?: string,
    reason?: string,
  ) => Promise<void>,
  retry: boolean,
) {
  await save('running');
  try {
    const outcome = await handler();
    if (outcome.status === 'done') await save('done', outcome.result);
    else
      await save(
        outcome.status === 'deferred' ? 'queued' : outcome.status,
        'result' in outcome ? outcome.result : undefined,
        outcome.reasonCode,
        outcome.reasonUk,
      );
  } catch (error) {
    await save(
      retry ? 'queued' : 'failed',
      undefined,
      error instanceof TaskFailure ? error.code : 'operation_failed',
      error instanceof TaskFailure
        ? error.reasonUk
        : 'Не вдалося виконати завдання. Перевірте підключення та повторіть.',
    );
    throw error;
  }
}
async function acquireGoogleCompanyLease(taskId: string) {
  const client = await sonarPool.connect();
  const key = `google.company:${taskId}`;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1,0))', [
      key,
    ]);
  } catch (error) {
    client.release(true);
    throw error;
  }
  return async () => {
    let destroy = false;
    try {
      await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [
        key,
      ]);
    } catch {
      destroy = true;
    } finally {
      client.release(destroy);
    }
  };
}
export async function runTask(
  type: string,
  handler: (payload: object, taskId: string) => Promise<TaskOutcome>,
  afterTerminal?: (payload: object) => Promise<void>,
) {
  await boss.work<
    { taskId: string; version?: string | null },
    unknown,
    { includeMetadata: true; batchSize: number }
  >(type, { includeMetadata: true, batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { rows } = await sonarPool.query(
      "select * from tasks where id=$1 and status in ('queued','running')",
      [job.data.taskId],
    );
    const task = rows[0];
    if (!task) return;
    const release =
      type === 'google.company'
        ? await acquireGoogleCompanyLease(task.id)
        : type === 'prozorro.company'
          ? await (
              await import('./prozorro.js')
            ).acquireProzorroCompanyLease(task.payload.companyId)
          : undefined;
    try {
      if (type === 'google.company') {
        const { rows: current } = await sonarPool.query(
          "select 1 from tasks where id=$1 and status in ('queued','running') and coalesce(payload->>'resolveVersion','0')=$2",
          [task.id, job.data.version ?? '0'],
        );
        if (
          !current.length ||
          String(task.payload.resolveVersion ?? 0) !== (job.data.version ?? '0')
        )
          return;
      }
      if (type === 'prozorro.company') {
        const { rows: current } = await sonarPool.query(
          "select 1 from tasks where id=$1 and status in ('queued','running') and coalesce(payload->>'version','')=$2",
          [task.id, job.data.version ?? ''],
        );
        if (
          !current.length ||
          (task.payload.version ?? '') !== (job.data.version ?? '')
        )
          return;
      }
      await executeTask(
        async () => {
          if (task.type !== type) throw new Error('Unknown task type');
          const outcome = await handler(task.payload, task.id);
          if (
            type === 'prozorro.company' &&
            'reasonCode' in outcome &&
            outcome.reasonCode === 'prozorro_identity_changed'
          )
            await sonarPool.query(
              'update tasks set payload=payload||\'{"pendingRefresh":true}\'::jsonb where id=$1',
              [task.id],
            );
          if (outcome.status === 'deferred')
            await transaction((client) =>
              dispatch(client, task.id, type, outcome.runAt),
            );
          return outcome;
        },
        async (status, result, code, reason) => {
          await sonarPool.query(
            `update tasks set status=$2::text::task_status,
    result=case when type='social.inbox.sync' and $2::text='running' then '{}'::jsonb else coalesce($3::jsonb,result) end,
    reason_code=$4, reason_uk=$5,
    attempts=attempts+case when $2::text='running' then 1 else 0 end,
    started_at=case when $2::text='running' then now() else started_at end,
    finished_at=case when $2::text in ('done','skipped','failed','paused') then now() else null end where id=$1`,
            [task.id, status, result ?? null, code ?? null, reason ?? null],
          );
          if (['done', 'skipped', 'failed', 'paused'].includes(status))
            await afterTerminal?.(task.payload);
        },
        job.retryCount < job.retryLimit,
      );
    } finally {
      await release?.();
    }
  });
}

export async function dismissTask(id: string, userId: string) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `update tasks set dismissed_at=now()
      where type=(select type from tasks where id=$1) and status in ('failed','paused')
      and dismissed_at is null and created_at <= (select created_at from tasks where id=$1)
      returning id`,
      [id],
    );
    if (rows.length)
      await logActivity(
        'task.dismiss',
        'task',
        id,
        userId,
        { count: rows.length },
        client,
      );
    return rows.length > 0;
  });
}

export async function enqueueProzorroSync(userId?: string | null) {
  return transaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('prozorro.enqueue',0))",
    );
    if (userId) {
      await client.query(
        "update settings set value='true',updated_at=now() where key='prozorro.full_sync.enabled'",
      );
      await logActivity('prozorro.start', 'settings', null, userId, {}, client);
    }
    const { rows } = await client.query(
      "select value from settings where key='prozorro.full_sync.enabled'",
    );
    if (rows[0]?.value !== true) return;
    // A killed worker can exhaust pg-boss retries before updating the CRM task.
    await client.query(
      `update tasks t set status='failed',finished_at=now(),reason_code='prozorro_interrupted',
       reason_uk='Попередній запуск перервано. Синхронізація продовжується зі збереженого курсора.'
       where type='prozorro.sync' and status in ('queued','running') and payload ? 'feed'
       and not exists(select 1 from pgboss.job j where j.name='prozorro.sync'
         and j.data->>'taskId'=t.id::text and j.state in ('created','retry','active'))`,
    );
    for (const feed of ['tender', 'contract']) {
      const { rows: active } = await client.query(
        "select 1 from tasks where type='prozorro.sync' and payload->>'feed'=$1 and status in ('queued','running')",
        [feed],
      );
      if (!active.length)
        await enqueueTask(
          'prozorro.sync',
          `prozorro.sync:${feed}:${randomUUID()}`,
          { feed },
          client,
        );
    }
  });
}
export class ProzorroCodeError extends Error {
  constructor(
    public reason: 'invalidCode' | 'conflictingCode' | 'companyBusy',
  ) {
    super(reason);
  }
}
// Caller holds the prozorro.company advisory lock and the company row lock.
export async function recordManualCompanyCode(
  client: PoolClient,
  companyId: string,
  manualCode: string,
  userId: string | null,
) {
  const { prozorroCompanyCodes } = await import('./prozorro.js');
  const existing = (await prozorroCompanyCodes(companyId, client, true)).filter(
    (fact) => fact.code,
  );
  if (existing.some((fact) => fact.code !== manualCode))
    throw new ProzorroCodeError('conflictingCode');
  if (!existing.length) {
    await client.query(
      "insert into company_facts(company_id,kind,value,source,source_url,found_at) values($1,'edrpou',$2,'manual',$3,now())",
      [companyId, JSON.stringify(manualCode), `/companies/${companyId}`],
    );
    await logActivity(
      'company.edrpou.manual',
      'company',
      companyId,
      userId,
      { code: manualCode },
      client,
    );
  }
}
type ProzorroEnqueueOptions = {
  manualCode?: string;
  taskId?: string;
  retry?: boolean;
  onlyIfStale?: boolean;
};
const prozorroLiveJobs = `select t.id,t.status,t.payload from tasks t join pgboss.job j on j.name='prozorro.company' and j.data->>'taskId'=t.id::text
  where t.type='prozorro.company' and t.payload->>'companyId'=$1 and j.state in ('created','retry','active') limit 1`;
async function lockProzorroCompany(client: PoolClient, companyId: string) {
  const { rows } = await client.query(
    "select pg_try_advisory_xact_lock(hashtextextended('prozorro.company:'||$1,0)) as locked",
    [companyId],
  );
  if (!rows[0]?.locked) return false;
  await client.query('select id from companies where id=$1 for update', [
    companyId,
  ]);
  return true;
}
async function recoverProzorroCompany(client: PoolClient, companyId: string) {
  return client.query(
    `update tasks t set status='failed',finished_at=now(),reason_code='prozorro_company_interrupted',
    reason_uk='Попередній пошук у Prozorro перервано. Повторіть завдання.'
    where type='prozorro.company' and payload->>'companyId'=$1 and status in ('queued','running')
    and not exists(select 1 from pgboss.job j where j.name='prozorro.company' and j.data->>'taskId'=t.id::text and j.state in ('created','retry','active'))`,
    [companyId],
  );
}
export async function enqueueProzorroCompany(
  companyId: string,
  userId: string | null = null,
  existingClient?: PoolClient,
  options: ProzorroEnqueueOptions = {},
) {
  const manualCode =
    options.manualCode === undefined ? null : prozorroCode(options.manualCode);
  if (options.manualCode !== undefined && !manualCode)
    throw new ProzorroCodeError('invalidCode');
  const save = async (client: PoolClient) => {
    const key = `prozorro.company:${companyId}:${new Date().toISOString().slice(0, 10)}`;
    if (!(await lockProzorroCompany(client, companyId))) {
      if (manualCode) throw new ProzorroCodeError('companyBusy');
      // A code correction requested during HTTP is revisited after the owner finishes.
      const { rows } = await client.query(
        "update tasks set payload=payload||'{\"pendingRefresh\":true}'::jsonb where id=(select id from tasks where type='prozorro.company' and payload->>'companyId'=$1 order by created_at desc limit 1) returning id,status",
        [companyId],
      );
      return {
        id: rows[0]?.id ?? null,
        status: rows[0]?.status === 'running' ? 'running' : 'queued',
        created: false,
      };
    }
    await recoverProzorroCompany(client, companyId);
    const { prozorroCompanyCode } = await import('./prozorro.js');
    if (manualCode)
      await recordManualCompanyCode(client, companyId, manualCode, userId);
    const code = await prozorroCompanyCode(companyId, client, true);
    if (manualCode && code !== manualCode)
      throw new ProzorroCodeError('conflictingCode');
    const { rows: live } = await client.query(prozorroLiveJobs, [companyId]);
    if (live[0]) {
      if ((live[0].payload.code ?? null) !== code)
        await client.query(
          'update tasks set payload=payload||\'{"pendingRefresh":true}\'::jsonb where id=$1',
          [live[0].id],
        );
      return { id: live[0].id, status: live[0].status, created: false };
    }
    if (options.onlyIfStale) {
      const { rows: fresh } = await client.query(
        "select 1 from company_facts where company_id=$1 and kind='prozorro_company' and source='prozorro' and value->>'code'=$2 and found_at>now()-interval '30 days'",
        [companyId, code],
      );
      if (fresh.length) return { id: null, status: 'done', created: false };
    }
    const { rows: previous } = await client.query(
      "select * from tasks where type='prozorro.company' and " +
        (options.taskId ? 'id=$1' : 'idempotency_key=$1') +
        ' for update',
      [options.taskId ?? key],
    );
    const old = previous[0];
    const payload = { companyId, code, version: randomUUID() };
    let created: string | null = null;
    if (old) {
      const oldCode = old.payload.code ?? old.result?.code ?? null;
      const changed = oldCode !== code;
      const retryable =
        options.retry && ['failed', 'paused', 'skipped'].includes(old.status);
      const resolved =
        old.reason_code === 'prozorro_missing_edrpou' && code !== null;
      if (changed || retryable || resolved) {
        await client.query(
          "update tasks set payload=$2,result=null,status='queued',reason_code=null,reason_uk=null,finished_at=null,dismissed_at=null where id=$1",
          [old.id, payload],
        );
        await dispatch(client, old.id, 'prozorro.company');
        created = old.id;
      } else if (old.payload.pendingRefresh) {
        await client.query(
          "update tasks set payload=payload-'pendingRefresh' where id=$1",
          [old.id],
        );
      }
    } else
      created = await enqueueTask('prozorro.company', key, payload, client);
    if (created) {
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [created, companyId],
      );
      await logActivity(
        'prozorro.company.queued',
        'company',
        companyId,
        userId,
        {},
        client,
      );
    }
    const { rows } = await client.query(
      'select id,status from tasks where id=$1 or idempotency_key=$2 order by created_at desc limit 1',
      [old?.id ?? created, key],
    );
    return { ...rows[0], created: !!created };
  };
  return existingClient ? save(existingClient) : transaction(save);
}
export async function reconcileProzorroCompanyTasks() {
  const { rows } = await sonarPool.query(
    "select distinct payload->>'companyId' as company_id from tasks where type='prozorro.company' and (status in ('queued','running') or payload @> '{\"pendingRefresh\":true}') order by company_id",
  );
  for (const { company_id: companyId } of rows)
    await transaction(async (client) => {
      if (!(await lockProzorroCompany(client, companyId))) return;
      await recoverProzorroCompany(client, companyId);
      const { rows: pending } = await client.query(
        "select id from tasks where type='prozorro.company' and payload->>'companyId'=$1 and payload @> '{\"pendingRefresh\":true}' order by created_at desc limit 1",
        [companyId],
      );
      if (pending[0])
        await enqueueProzorroCompany(companyId, null, client, {
          taskId: pending[0].id,
        });
    });
}
export async function enqueueCampaignProzorro(
  campaignId: string,
  userId: string,
) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'select distinct cc.company_id from campaign_companies cc where cc.campaign_id=$1 order by cc.company_id',
      [campaignId],
    );
    let count = 0;
    for (const row of rows)
      if (
        (
          await enqueueProzorroCompany(row.company_id, userId, client, {
            onlyIfStale: true,
          })
        ).created
      )
        count++;
    return count;
  });
}
// Compatibility entry point for the enrichment chain; no local full-feed lookup is queued.
export async function enqueueProzorroLookup(companyId: string) {
  const { rows } = await sonarPool.query(
    "select value from settings where key='prozorro.enabled'",
  );
  const { rows: matched } = await sonarPool.query(
    "select 1 from company_facts where company_id=$1 and source='registry' and kind='registry_entity'",
    [companyId],
  );
  const { rows: registryTask } = await sonarPool.query(
    "select status from tasks where type='registry.match' and payload->>'companyId'=$1 order by created_at desc limit 1",
    [companyId],
  );
  if (
    rows[0]?.value !== true ||
    !matched.length ||
    registryTask[0]?.status !== 'done'
  )
    return finishEnrichment(companyId);
  const task = await enqueueProzorroCompany(companyId);
  if (!['queued', 'running'].includes(task.status))
    await finishEnrichment(companyId);
  return task;
}

// Enrichment chain: site.scan -> registry.match -> prozorro.company -> company.score.
// Each stage is its own task; a failed stage never blocks the next one.
export async function enqueueEnrichment(
  companyId: string,
  userId: string | null,
) {
  await sonarPool.query(
    "update companies set status='enriching',updated_at=now() where id=$1 and status in ('new','ready','enriching')",
    [companyId],
  );
  const scan = await enqueueSiteScan(companyId, userId);
  if (!scan) return continueEnrichment(companyId);
  // A scan finished earlier today will not run again; move straight on.
  if (!scan.created && !['queued', 'running'].includes(scan.status))
    return continueEnrichment(companyId);
  return scan;
}
export async function continueEnrichment(companyId: string) {
  const match = await enqueueRegistryMatch(companyId, null);
  if (!match.created && !['queued', 'running'].includes(match.status))
    await enqueueProzorroLookup(companyId);
  return match;
}
export async function finishEnrichment(companyId: string) {
  await enqueueCompanyScores(companyId);
}
export async function enqueueBatchEnrichment(
  batchId: string,
  userId: string | null,
) {
  const { rows } = await sonarPool.query(
    "select cc.company_id from campaign_companies cc join companies c on c.id=cc.company_id where cc.batch_id=$1 and c.status in ('new','ready','enriching') order by cc.added_at",
    [batchId],
  );
  for (const row of rows) await enqueueEnrichment(row.company_id, userId);
  await logActivity('batch.enrich', 'batch', batchId, userId, {
    companies: rows.length,
  });
  return rows.length;
}
