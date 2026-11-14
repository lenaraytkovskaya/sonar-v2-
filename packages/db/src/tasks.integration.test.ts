import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
// Run only against a disposable database with the migrations applied.
const queue = `test.${randomUUID()}`;
it.skipIf(!enabled)(
  'clears only inbox attempt results before early outcomes or exceptions through the real SQL writer',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { boss, retryTask, runTask } = await import('./tasks.js');
    const { runSocialInboxSync } =
      await import('../../../apps/worker/src/social-inbox.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    const control = `test.${randomUUID()}`;
    const user = randomUUID();
    const ids: string[] = [];
    const stale = { diagnostic: { stage: 'capture_auth' }, created: 5 };
    type Handler = () => Promise<import('./tasks.js').TaskOutcome>;
    type Job = {
      data: { taskId: string };
      retryCount: number;
      retryLimit: number;
    };
    let consume: (jobs: Job[]) => Promise<unknown>;
    // Only queue delivery is manual; retry, running and final writes use real Postgres.
    const delivery = vi.spyOn(boss, 'work').mockImplementation((async (
      _type: string,
      _options: unknown,
      handler: typeof consume,
    ) => {
      consume = handler;
      return 'test-delivery';
    }) as never);
    const cases: {
      name: string;
      handler: Handler;
      status: string;
      reason: string | null;
      result: object;
      control?: boolean;
      throws?: boolean;
    }[] = [
      {
        name: 'inactive',
        handler: () =>
          runSocialInboxSync(
            { accountId: randomUUID() },
            {
              sync: async () => {
                throw Error('must not run');
              },
            },
          ),
        status: 'paused',
        reason: 'social_account_inactive',
        result: {},
      },
      {
        name: 'missing-adapter',
        handler: () => runSocialInboxSync({ accountId: randomUUID() }),
        status: 'skipped',
        reason: 'social_inbox_missing_adapter',
        result: {},
      },
      {
        name: 'no-diagnostic',
        handler: async () => ({
          status: 'paused',
          reasonCode: 'social_inbox_unknown_auth',
          reasonUk: 'Сесію не підтверджено.',
        }),
        status: 'paused',
        reason: 'social_inbox_unknown_auth',
        result: {},
      },
      {
        name: 'exception',
        handler: async () => {
          throw Error('synthetic failure');
        },
        status: 'failed',
        reason: 'operation_failed',
        result: {},
        throws: true,
      },
      {
        name: 'deferred',
        handler: async () => ({
          status: 'deferred',
          runAt: new Date(Date.now() + 60000),
          reasonCode: 'social_account_busy',
          reasonUk: 'Акаунт зайнятий.',
        }),
        status: 'queued',
        reason: 'social_account_busy',
        result: {},
      },
      {
        name: 'fresh-diagnostic',
        handler: async () => ({
          status: 'paused',
          reasonCode: 'social_inbox_unknown_auth',
          reasonUk: 'Сесію не підтверджено.',
          result: { diagnostic: { stage: 'identity' } },
        }),
        status: 'paused',
        reason: 'social_inbox_unknown_auth',
        result: { diagnostic: { stage: 'identity' } },
      },
      {
        name: 'other-type',
        handler: async () => ({
          status: 'paused',
          reasonCode: 'control',
          reasonUk: 'Перевірка.',
        }),
        status: 'paused',
        reason: 'control',
        result: stale,
        control: true,
      },
    ];
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Test','test')",
        [user, `${user}@example.invalid`],
      );
      for (const type of ['social.inbox.sync', control]) {
        await admin.createQueue(type);
        await sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do nothing',
          [
            `tasks.${type}`,
            { retryLimit: 0, retryDelay: 1, expireInSeconds: 60 },
          ],
        );
      }
      for (const scenario of cases) {
        const type = scenario.control ? control : 'social.inbox.sync';
        const id = randomUUID();
        ids.push(id);
        await sonarPool.query(
          "insert into tasks(id,type,idempotency_key,status,payload,result) values($1::uuid,$2,$1::uuid::text,'paused',$3,$4)",
          [id, type, { accountId: randomUUID() }, stale],
        );
        expect(await retryTask(id, user)).toBe(true);
        let runningResult: unknown;
        await runTask(type, async () => {
          runningResult = (
            await sonarPool.query('select result from tasks where id=$1', [id])
          ).rows[0].result;
          return scenario.handler();
        });
        const execution = consume!([
          { data: { taskId: id }, retryCount: 0, retryLimit: 0 },
        ]);
        if (scenario.throws)
          await expect(execution).rejects.toThrow('synthetic failure');
        else await execution;
        const stored = (
          await sonarPool.query(
            'select status,result,reason_code,attempts from tasks where id=$1',
            [id],
          )
        ).rows[0];
        expect(stored, scenario.name).toEqual({
          status: scenario.status,
          result: scenario.result,
          reason_code: scenario.reason,
          attempts: 1,
        });
        expect(runningResult, scenario.name).toEqual(
          scenario.control ? stale : {},
        );
      }
    } finally {
      delivery.mockRestore();
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [ids],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from users where id=$1', [user]);
      await sonarPool.query('delete from settings where key=$1', [
        `tasks.${control}`,
      ]);
      await admin.deleteQueue('social.inbox.sync');
      await admin.deleteQueue(control);
      await admin.stop();
    }
  },
);
it.skipIf(!enabled)(
  'atomic enqueue/retry, final failure, audit and recovery',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { boss, enqueueTask, retryTask, runTask } =
      await import('./tasks.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue(queue);
    await sonarPool.query('insert into settings(key,value) values($1,$2)', [
      `tasks.${queue}`,
      { retryLimit: 0, retryDelay: 1, expireInSeconds: 60 },
    ]);
    let phase: 'failed' | 'paused' | 'done' = 'failed';
    const key = randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => enqueueTask(queue, key)),
    );
    expect(ids.filter(Boolean)).toHaveLength(1);
    const id = ids.find(Boolean);
    await boss.start();
    await runTask(queue, async () => {
      if (phase === 'failed') throw Error('offline');
      if (phase === 'paused')
        return {
          status: 'paused',
          result: { valid: false, diagnostic: { version: 1 } },
          reasonCode: 'social_session_unknown_auth',
          reasonUk: 'Сесію не підтверджено.',
        };
      return { status: 'done', result: { recovered: true } };
    });
    const wait = async (status: string) => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await sonarPool.query(
          'select * from tasks where id=$1',
          [id],
        );
        if (rows[0].status === status) return rows[0];
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error(`Missing state ${status}`);
    };
    expect((await wait('failed')).reason_uk).toBeTruthy();
    phase = 'paused';
    await sonarPool.query('update tasks set result=$2 where id=$1', [
      id,
      { stale: true },
    ]);
    const {
      rows: [user],
    } = await sonarPool.query(
      "insert into users(email,name,password_hash) values($1,'Test','test') returning id",
      [`${key}@example.invalid`],
    );
    const retries = await Promise.all(
      Array.from({ length: 10 }, () => retryTask(id, user.id)),
    );
    expect(retries.filter(Boolean)).toHaveLength(1);
    expect((await wait('paused')).result).toEqual({
      valid: false,
      diagnostic: { version: 1 },
    });
    phase = 'done';
    expect(await retryTask(id, user.id)).toBe(true);
    expect((await wait('done')).result).toEqual({ recovered: true });
    expect(
      (
        await sonarPool.query(
          'select count(*)::int as n from activity_log where entity_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(2);
    await sonarPool.query('delete from activity_log where entity_id=$1', [id]);
    await sonarPool.query('delete from tasks where id=$1', [id]);
    await sonarPool.query('delete from users where id=$1', [user.id]);
    await sonarPool.query('delete from settings where key=$1', [
      `tasks.${queue}`,
    ]);
    await boss.deleteQueue(queue);
    await admin.stop();
  },
  30000,
);
afterAll(async () => {
  if (enabled) {
    const { closeTaskQueue } = await import('./tasks.js');
    await closeTaskQueue();
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
