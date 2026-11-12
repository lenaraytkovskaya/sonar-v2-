import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'adopts only persisted valid candidates atomically, logs the user and enqueues once',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { adoptWebsiteCandidate } = await import('./companies.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('site.scan');
    const {
      rows: [user],
    } = await sonarPool.query(
      "insert into users(email,name,password_hash) values($1,'Candidate tester','unused') returning id",
      [randomUUID() + '@example.test'],
    );
    const {
      rows: [company],
    } = await sonarPool.query(
      "insert into companies(place_id,name,website,domain) values($1,'Candidate test','https://prom.ua/listing','prom.ua') returning id",
      [randomUUID()],
    );
    const lockClient = await sonarPool.connect();
    try {
      const facts = [];
      for (const [value, expiry] of [
        ['https://WWW.Example.test/path#fragment', null],
        ['javascript:alert(1)', null],
        ['https://expired.test', new Date(0)],
      ]) {
        const {
          rows: [fact],
        } = await sonarPool.query(
          "insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,'website_candidate',$2,'website','https://prom.ua/listing',$3) returning id",
          [company.id, JSON.stringify(value), expiry],
        );
        facts.push(fact.id);
      }
      for (const factId of [randomUUID(), facts[1], facts[2]])
        await expect(
          adoptWebsiteCandidate(company.id, factId, user.id),
        ).rejects.toThrow('staleCandidate');
      await lockClient.query(
        'select pg_advisory_lock(hashtextextended($1,0))',
        [`site.scan:${company.id}`],
      );
      await expect(
        adoptWebsiteCandidate(company.id, facts[0], user.id),
      ).rejects.toThrow('scanRunning');
      await lockClient.query(
        'select pg_advisory_unlock(hashtextextended($1,0))',
        [`site.scan:${company.id}`],
      );
      const result = await adoptWebsiteCandidate(company.id, facts[0], user.id);
      expect(result.changed).toBe(true);
      expect(result.task?.created).toBe(true);
      expect(
        await adoptWebsiteCandidate(company.id, facts[0], user.id),
      ).toEqual({ changed: false });
      const {
        rows: [updated],
      } = await sonarPool.query(
        'select website,domain from companies where id=$1',
        [company.id],
      );
      expect(updated).toEqual({
        website: 'https://www.example.test/path',
        domain: 'example.test',
      });
      const { rows: history } = await sonarPool.query(
        "select user_id,details from activity_log where entity_id=$1 and action='company.website.adopted'",
        [company.id],
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        user_id: user.id,
        details: {
          factId: facts[0],
          previousWebsite: 'https://prom.ua/listing',
        },
      });
      expect(
        (
          await sonarPool.query('select id from tasks where subject_id=$1', [
            company.id,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await lockClient.query('select pg_advisory_unlock_all()');
      lockClient.release();
      await sonarPool.query(
        "delete from pgboss.job where data->>'taskId' in (select id::text from tasks where subject_id=$1)",
        [company.id],
      );
      await sonarPool.query('delete from tasks where subject_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from company_facts where company_id=$1', [
        company.id,
      ]);
      await sonarPool.query('delete from companies where id=$1', [company.id]);
      await sonarPool.query('delete from users where id=$1', [user.id]);
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
