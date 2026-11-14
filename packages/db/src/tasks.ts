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
  await producer.send(
    type,
    { taskId: id },
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
    if (id) await dispatch(client, id, type);
    return id ?? null;
  };
  return existingClient ? save(existingClient) : transaction(save);
}
export async function enqueueSiteScan(
  companyId: string,
  userId: string | null,
  existingClient?: PoolClient,
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
    if (userId) {
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
    const created = await enqueueTask('site.scan', key, { companyId }, client);
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
export async function retryTask(id: string, userId: string) {
  return transaction(async (client) => {
    const {
      rows: [original],
    } = await client.query('select * from tasks where id=$1 for update', [id]);
    if (
      !original ||
      original.result?.billingPending ||
      original.type === 'social.request' ||
      original.type.startsWith('whatsapp.account.')
    )
      return false;
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
      const { prepareSocialRetry } = await import('./social.js');
      if (!(await prepareSocialRetry(client, original))) return false;
    }
    const { rows: settled } = await client.query(
      "select id from spend_events where task_id=$1 and (meta ? 'error' or meta ? 'reconciliation')",
      [id],
    );
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
  | { status: 'deferred'; runAt: Date; reasonCode: string; reasonUk: string };
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
export async function runTask(
  type: string,
  handler: (payload: object, taskId: string) => Promise<TaskOutcome>,
  afterTerminal?: (payload: object) => Promise<void>,
) {
  await boss.work<
    { taskId: string },
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
    await executeTask(
      async () => {
        if (task.type !== type) throw new Error('Unknown task type');
        const outcome = await handler(task.payload, task.id);
        if (outcome.status === 'deferred')
          await transaction((client) =>
            dispatch(client, task.id, type, outcome.runAt),
          );
        return outcome;
      },
      async (status, result, code, reason) => {
        await sonarPool.query(
          `update tasks set status=$2::text::task_status, result=coalesce($3::jsonb,result), reason_code=$4, reason_uk=$5,
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
        "update settings set value='true',updated_at=now() where key='prozorro.enabled'",
      );
      await logActivity('prozorro.start', 'settings', null, userId, {}, client);
    }
    const { rows } = await client.query(
      "select value from settings where key='prozorro.enabled'",
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
export async function enqueueProzorroLookup(companyId: string) {
  const key = `prozorro.lookup:${companyId}:${new Date().toISOString().slice(0, 10)}`;
  const created = await enqueueTask('prozorro.lookup', key, { companyId });
  if (created)
    await sonarPool.query(
      "update tasks set subject_type='company',subject_id=$2 where id=$1",
      [created, companyId],
    );
  else {
    const { rows } = await sonarPool.query(
      'select status from tasks where idempotency_key=$1',
      [key],
    );
    if (!['queued', 'running'].includes(rows[0]?.status))
      await finishEnrichment(companyId);
  }
}

// Enrichment chain: site.scan -> registry.match -> prozorro.lookup -> company.score.
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
