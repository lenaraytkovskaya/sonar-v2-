import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'records worker identity and keeps database health OK when its heartbeat expires',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { recordWorkerHeartbeat, readWorkerHealth } =
      await import('./tasks.js');
    const { GET } =
      await import('../../../apps/web/src/app/api/health/route.js');
    const { rows: original } = await sonarPool.query(
      "select key,value from settings where key in ('worker.heartbeat_at','worker.stale_seconds')",
    );
    try {
      await sonarPool.query(
        "delete from settings where key='worker.heartbeat_at'",
      );
      expect((await GET()).status).toBe(200);
      expect(await (await GET()).json()).toMatchObject({
        ok: true,
        db: true,
        worker: false,
      });
      const startedAt = '2026-11-17T12:00:00Z';
      await recordWorkerHeartbeat(startedAt, '2.1.0');
      expect(await readWorkerHealth()).toMatchObject({
        worker: true,
        startedAt,
        version: '2.1.0',
      });
      expect(await (await GET()).json()).toMatchObject({
        ok: true,
        worker: true,
      });
      await sonarPool.query(
        "update settings set value=jsonb_set(value,'{at}',to_jsonb((now()-interval '4 minutes')::text)) where key='worker.heartbeat_at'",
      );
      expect(await (await GET()).json()).toMatchObject({
        ok: true,
        worker: false,
      });
      await sonarPool.query(
        "update settings set value='300' where key='worker.stale_seconds'",
      );
      expect(await (await GET()).json()).toMatchObject({
        ok: true,
        worker: true,
      });
    } finally {
      await sonarPool.query(
        "delete from settings where key in ('worker.heartbeat_at','worker.stale_seconds')",
      );
      for (const { key, value } of original) {
        await sonarPool.query('insert into settings(key,value) values($1,$2)', [
          key,
          JSON.stringify(value),
        ]);
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
