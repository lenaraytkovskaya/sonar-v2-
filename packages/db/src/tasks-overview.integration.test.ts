import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'hides failures older than the configured visibility window',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { overviewFailures } = await import('./tasks.js');
    const recentKey = `visibility:${randomUUID()}:recent`;
    const oldKey = `visibility:${randomUUID()}:old`;
    const { rows: original } = await sonarPool.query(
      "select value from settings where key='tasks.failure_visible_days'",
    );
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('tasks.failure_visible_days','7') on conflict(key) do update set value='7'",
      );
      await sonarPool.query(
        `insert into tasks(type,status,idempotency_key,reason_uk,created_at,finished_at)
       values ('visibility.test','failed',$1,'recent failure',now()-interval '1 day',now()-interval '1 day'),
              ('visibility.test','failed',$2,'old failure',now()-interval '9 days',now()-interval '9 days')`,
        [recentKey, oldKey],
      );

      const { failures, olderFailures } = await overviewFailures();
      expect(failures.map((task) => task.reason_uk)).toContain(
        'recent failure',
      );
      expect(olderFailures.map((task) => task.reason_uk)).toContain(
        'old failure',
      );
    } finally {
      await sonarPool.query(
        'delete from tasks where idempotency_key = any($1::text[])',
        [[recentKey, oldKey]],
      );
      await sonarPool.query(
        "delete from settings where key='tasks.failure_visible_days'",
      );
      if (original[0]) {
        await sonarPool.query(
          "insert into settings(key,value) values('tasks.failure_visible_days',$1::jsonb)",
          [JSON.stringify(original[0].value)],
        );
      }
    }
  },
);

afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
