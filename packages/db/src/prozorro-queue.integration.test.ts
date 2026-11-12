import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
it.skipIf(!enabled)(
  'recovers an orphaned running sync task while preserving an active queued feed',
  async () => {
    db = await import('./index.js');
    const { PgBoss } = await import('pg-boss');
    const { enqueueTask, enqueueProzorroSync } = await import('./tasks.js');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('prozorro.sync');
    const previous = (
      await db.sonarPool.query(
        "select value from settings where key='prozorro.enabled'",
      )
    ).rows[0]?.value;
    const before = (
      await db.sonarPool.query(
        "select id from tasks where type='prozorro.sync'",
      )
    ).rows.map((r) => r.id);
    try {
      await db.sonarPool.query(
        "update settings set value='true' where key='prozorro.enabled'",
      );
      const orphanId = randomUUID();
      await db.sonarPool.query(
        "insert into tasks(id,type,status,idempotency_key,payload,started_at) values($1,'prozorro.sync','running',$2,'{\"feed\":\"tender\"}',now()-interval '1 hour')",
        [orphanId, randomUUID()],
      );
      const contractId = await enqueueTask('prozorro.sync', randomUUID(), {
        feed: 'contract',
      });
      await enqueueProzorroSync();
      expect(
        (
          await db.sonarPool.query(
            'select status,reason_uk from tasks where id=$1',
            [orphanId],
          )
        ).rows[0],
      ).toMatchObject({ status: 'failed', reason_uk: expect.any(String) });
      const active = (
        await db.sonarPool.query(
          "select id,payload->>'feed' as feed from tasks where type='prozorro.sync' and status in ('queued','running') and not(id=any($1::uuid[]))",
          [before],
        )
      ).rows;
      expect(active.filter((r) => r.feed === 'contract')).toEqual([
        { id: contractId, feed: 'contract' },
      ]);
      expect(active.filter((r) => r.feed === 'tender')).toHaveLength(1);
      await enqueueProzorroSync();
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as count from tasks where type='prozorro.sync' and status in ('queued','running') and not(id=any($1::uuid[]))",
            [before],
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      const ids = (
        await db.sonarPool.query(
          "select id from tasks where type='prozorro.sync' and not(id=any($1::uuid[]))",
          [before],
        )
      ).rows.map((r) => r.id);
      await db.sonarPool.query(
        "delete from pgboss.job where name='prozorro.sync' and data->>'taskId'=any($1::text[])",
        [ids],
      );
      await db.sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await db.sonarPool.query(
        "update settings set value=$1 where key='prozorro.enabled'",
        [JSON.stringify(previous)],
      );
      await admin.stop();
    }
  },
);
afterAll(async () => {
  if (!db) return;
  const { closeTaskQueue } = await import('./tasks.js');
  await closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
