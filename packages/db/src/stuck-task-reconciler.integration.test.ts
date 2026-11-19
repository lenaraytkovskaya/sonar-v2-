import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_DB_TESTS === '1';
const ids: string[] = [];
const types = [
  'message.send',
  'company.analyze',
  'viber.inbox.sync',
  'company.score',
];
let sonarPool: typeof import('./index.js').sonarPool;
let admin: import('pg-boss').PgBoss;
let reconcileStuckTasks: typeof import('./tasks.js').reconcileStuckTasks;

beforeAll(async () => {
  if (!enabled) return;
  const db = await import('./index.js');
  const { PgBoss } = await import('pg-boss');
  ({ reconcileStuckTasks } = await import('./tasks.js'));
  sonarPool = db.sonarPool;
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const type of types) await admin.createQueue(type);
});

async function createStuckTask(
  type: string,
  result: object | null = null,
  idempotencyKey = `reconcile:${type}:${randomUUID()}`,
  stale = true,
) {
  const id = randomUUID();
  ids.push(id);
  await sonarPool.query(
    `insert into tasks(id,type,idempotency_key,status,payload,result,attempts,started_at,updated_at)
     values($1,$2,$3,'running','{}'::jsonb,$4,1,now()-interval '2 days',
       case when $5 then now()-interval '2 days' else now() end)`,
    [id, type, idempotencyKey, result, stale],
  );
  return { id, idempotencyKey };
}

it.skipIf(!enabled)(
  'pauses an interrupted send without changing its idempotency key or scheduling a retry',
  async () => {
    const key = `reconcile:send:${randomUUID()}`;
    const task = await createStuckTask('message.send', { sendAttempt: 1 }, key);

    const summary = await reconcileStuckTasks();
    const { rows } = await sonarPool.query(
      'select status,reason_code,reason_uk,result,idempotency_key from tasks where id=$1',
      [task.id],
    );
    const { rows: jobs } = await sonarPool.query(
      "select id from pgboss.job where name='message.send' and data->>'taskId'=$1",
      [task.id],
    );

    expect(rows[0]).toEqual({
      status: 'paused',
      reason_code: 'task_interrupted',
      reason_uk:
        'Задачу перервано (перезапуск сервера). Результат невідомий — перевірте вручну перед повтором.',
      result: { sendAttempt: 1 },
      idempotency_key: key,
    });
    expect(jobs).toHaveLength(0);
    expect(summary.byType['message.send']).toEqual({ queued: 0, paused: 1 });
  },
);

it.skipIf(!enabled)(
  'pauses an interrupted paid task and keeps its billing reservation unchanged',
  async () => {
    const reservation = {
      billingPending: true,
      billingEstimate: 0.25,
      billingService: 'openrouter',
      billingAt: new Date().toISOString(),
    };
    const { id } = await createStuckTask('company.analyze', reservation);

    await reconcileStuckTasks();
    const { rows } = await sonarPool.query(
      `select status,reason_code,result,
         (result->>'billingEstimate')::numeric as reserved_usd
       from tasks where id=$1`,
      [id],
    );
    const { rows: spend } = await sonarPool.query(
      'select count(*)::int as count from spend_events where task_id=$1',
      [id],
    );

    expect(rows[0]).toMatchObject({
      status: 'paused',
      reason_code: 'task_interrupted',
      result: reservation,
      reserved_usd: '0.25',
    });
    expect(spend[0].count).toBe(0);
  },
);

it.skipIf(!enabled)(
  'requeues an interrupted safe inbox sync and dispatches the same task',
  async () => {
    const { id } = await createStuckTask('viber.inbox.sync');

    const summary = await reconcileStuckTasks();
    const { rows: task } = await sonarPool.query(
      'select status,reason_code from tasks where id=$1',
      [id],
    );
    const { rows: jobs } = await sonarPool.query(
      "select state from pgboss.job where name='viber.inbox.sync' and data->>'taskId'=$1",
      [id],
    );
    const { rows: activity } = await sonarPool.query(
      "select details from activity_log where action='task.reconciled' and details->'taskIds' ? $1 limit 1",
      [id],
    );

    expect(task[0]).toEqual({ status: 'queued', reason_code: null });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('created');
    expect(activity[0].details).toMatchObject({
      reconciled: 1,
      byType: { 'viber.inbox.sync': { queued: 1, paused: 0 } },
    });
    expect(summary.byType['viber.inbox.sync']).toEqual({
      queued: 1,
      paused: 0,
    });
    expect((await reconcileStuckTasks()).reconciled).toBe(0);
    const { rows: jobsAfterRepeat } = await sonarPool.query(
      "select id from pgboss.job where name='viber.inbox.sync' and data->>'taskId'=$1",
      [id],
    );
    expect(jobsAfterRepeat).toHaveLength(1);
  },
);

it.skipIf(!enabled)(
  'leaves a fresh CRM task alone while its pg-boss job is active',
  async () => {
    const activeStates = ['created', 'retry', 'active'];
    const taskIds = await Promise.all(
      activeStates.map(async (state) => {
        const { id } = await createStuckTask(
          'company.score',
          null,
          undefined,
          false,
        );
        await admin.send('company.score', { taskId: id });
        if (state !== 'created')
          await sonarPool.query(
            "update pgboss.job set state=$2 where name='company.score' and data->>'taskId'=$1",
            [id, state],
          );
        return id;
      }),
    );

    await reconcileStuckTasks();
    const { rows } = await sonarPool.query(
      'select status,reason_code from tasks where id=any($1::uuid[]) order by id',
      [taskIds],
    );

    expect(rows).toHaveLength(activeStates.length);
    expect(rows.every((row) => row.status === 'running')).toBe(true);
    expect(rows.every((row) => row.reason_code === null)).toBe(true);
    await sonarPool.query(
      "delete from pgboss.job where data->>'taskId'=any($1::text[])",
      [taskIds],
    );
    await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
      taskIds,
    ]);
  },
);

it.skipIf(!enabled)(
  'reconciles a task past its configured expiry even when pg-boss still has an active job',
  async () => {
    const { id } = await createStuckTask('company.score');
    await admin.send('company.score', { taskId: id });
    await sonarPool.query(
      "update pgboss.job set state='active' where name='company.score' and data->>'taskId'=$1",
      [id],
    );

    const summary = await reconcileStuckTasks();
    const { rows } = await sonarPool.query(
      'select status from tasks where id=$1',
      [id],
    );

    expect(rows[0].status).toBe('queued');
    expect(summary.byType['company.score']).toEqual({ queued: 1, paused: 0 });
  },
);

it.skipIf(!enabled)(
  'does not overwrite a later worker attempt when an interrupted handler finishes last',
  async () => {
    const { id } = await createStuckTask('company.score');
    const { rows: settings } = await sonarPool.query(
      "select key,value from settings where key in ('tasks.reconciler','tasks.company.score')",
    );
    const original = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    await sonarPool.query(
      "update settings set value=$1 where key='tasks.reconciler'",
      [{ ...original['tasks.reconciler'], staleBufferSeconds: 0 }],
    );
    await sonarPool.query(
      "update settings set value=$1 where key='tasks.company.score'",
      [{ ...original['tasks.company.score'], expireInSeconds: 1 }],
    );
    const { boss, runTask } = await import('./tasks.js');
    type Job = {
      data: { taskId: string };
      retryCount: number;
      retryLimit: number;
    };
    let consume: ((jobs: Job[]) => Promise<unknown>) | undefined;
    const delivery = vi.spyOn(boss, 'work').mockImplementation((async (
      _type: string,
      _options: unknown,
      handler: typeof consume,
    ) => {
      consume = handler as typeof consume;
      return 'test-delivery';
    }) as never);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let calls = 0;
    let firstExecution: Promise<unknown> | undefined;
    try {
      await runTask('company.score', async () => {
        const attempt = ++calls;
        if (attempt === 1) {
          markFirstStarted();
          await firstGate;
        }
        return { status: 'done', result: { completedBy: attempt } };
      });
      firstExecution = consume!([
        { data: { taskId: id }, retryCount: 0, retryLimit: 0 },
      ]);
      await firstStarted;
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect((await reconcileStuckTasks()).byType['company.score']).toEqual({
        queued: 1,
        paused: 0,
      });
      await consume!([{ data: { taskId: id }, retryCount: 0, retryLimit: 0 }]);
      releaseFirst();
      await firstExecution;

      const { rows } = await sonarPool.query(
        'select status,result from tasks where id=$1',
        [id],
      );
      expect(rows[0]).toEqual({
        status: 'done',
        result: { completedBy: 2 },
      });
    } finally {
      releaseFirst();
      await firstExecution?.catch(() => undefined);
      delivery.mockRestore();
      for (const setting of settings)
        await sonarPool.query('update settings set value=$2 where key=$1', [
          setting.key,
          setting.value,
        ]);
    }
  },
);

afterAll(async () => {
  if (!enabled) return;
  try {
    await sonarPool.query(
      "delete from pgboss.job where data->>'taskId'=any($1::text[])",
      [ids],
    );
    await sonarPool.query(
      "delete from activity_log where action='task.reconciled' and details->'taskIds' ?| $1::text[]",
      [ids],
    );
    await sonarPool.query('delete from tasks where id=any($1::uuid[])', [ids]);
    await admin.stop();
    const { closeTaskQueue } = await import('./tasks.js');
    await closeTaskQueue();
    const { registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  } catch (error) {
    console.error('stuck task reconciler test cleanup failed', error);
    throw error;
  }
});
