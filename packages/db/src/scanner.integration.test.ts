import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'scanner facts and contacts preserve provenance, and concurrent daily enqueue creates one job',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { enqueueSiteScan } = await import('./tasks.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('site.scan');
    const {
      rows: [company],
    } = await sonarPool.query(
      "insert into companies(place_id,name,website) values($1,'Scanner test','https://example.test') returning id",
      [randomUUID()],
    );
    try {
      const scans = await Promise.all(
        Array.from({ length: 5 }, () => enqueueSiteScan(company.id, null)),
      );
      expect(scans.filter((scan) => scan?.created)).toHaveLength(1);
      expect(new Set(scans.map((scan) => scan?.id)).size).toBe(1);
      const {
        rows: [task],
      } = await sonarPool.query('select * from tasks where id=$1', [
        scans[0]!.id,
      ]);
      expect(task.idempotency_key).toBe(
        `site.scan:${company.id}:${new Date().toISOString().slice(0, 10)}`,
      );
      expect(task.subject_id).toBe(company.id);
      expect(task.subject_type).toBe('company');
      for (const value of [
        '{"code":"12345678","valid":true}',
        '{"valid":true,"code":"12345678"}',
      ])
        await sonarPool.query(
          "insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,'edrpou',$2,'ai','https://example.test/contact',now()+interval '365 days') on conflict do nothing",
          [company.id, value],
        );
      const { rows: facts } = await sonarPool.query(
        'select * from company_facts where company_id=$1',
        [company.id],
      );
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        source: 'ai',
        source_url: 'https://example.test/contact',
      });
      expect(facts[0].expires_at.getTime()).toBeGreaterThan(
        facts[0].found_at.getTime(),
      );
      await expect(
        sonarPool.query(
          "insert into company_facts(company_id,kind,value,source) values($1,'language','\"uk\"','invented')",
          [company.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      for (let i = 0; i < 2; i++)
        await sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source,source_url,meta) values($1,'email','team@example.test','team@example.test','website','https://example.test/contact','{\"ai\":true}') on conflict do nothing",
          [company.id],
        );
      const { rows: contacts } = await sonarPool.query(
        'select * from contacts where company_id=$1',
        [company.id],
      );
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        source: 'website',
        meta: { ai: true },
        source_url: 'https://example.test/contact',
      });
    } finally {
      await sonarPool.query('delete from company_facts where company_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from contacts where company_id=$1', [
        company.id,
      ]);
      await sonarPool.query(
        "delete from pgboss.job where name='site.scan' and data->>'taskId' in (select id::text from tasks where subject_id=$1)",
        [company.id],
      );
      await sonarPool.query('delete from tasks where subject_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from companies where id=$1', [company.id]);
      await admin.stop();
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { closeTaskQueue } = await import('./tasks.js');
    const { sonarPool, registryPool } = await import('./index.js');
    await closeTaskQueue();
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
