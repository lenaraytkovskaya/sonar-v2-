import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
// Run only against a disposable database with the migrations applied.
const queue = `test.${randomUUID()}`;
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
