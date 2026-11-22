import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'shares overview queries, scopes failures before resolution, and keeps reasons and paid identities',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { taskOverviewData } = await import('./task-overview.js');
    const [a, b, company, batchA, batchB] = Array.from({ length: 5 }, () =>
      randomUUID(),
    ) as [string, string, string, string, string];
    const ids: string[] = [];
    const oldSetting = (
      await sonarPool.query(
        "select value from settings where key='tasks.failure_visible_days'",
      )
    ).rows[0];
    const add = async (
      type: string,
      campaignId: string | null,
      status: string,
      reason: string,
      age = 0,
      pending = false,
      batchId: string | null = null,
    ) => {
      const id = randomUUID();
      ids.push(id);
      await sonarPool.query(
        "insert into tasks(id,type,status,idempotency_key,payload,subject_type,subject_id,reason_uk,created_at,result,batch_id) values($1::uuid,$2,$3,$1::text,$4,'company',$5,$6,now()-$7*interval '1 day',$8,$9)",
        [
          id,
          type,
          status,
          JSON.stringify(
            campaignId
              ? { campaignId, companyId: company }
              : { companyId: company },
          ),
          company,
          reason,
          age,
          JSON.stringify(pending ? { billingPending: true } : {}),
          batchId,
        ],
      );
      return id;
    };
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('tasks.failure_visible_days','7') on conflict(key) do update set value='7'",
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'A','UA','uk','{}','{}','',1,'{}','{}'),($2,'B','UA','uk','{}','{}','',1,'{}','{}')",
        [a, b],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name) values($1::uuid,$1::text,'Shared')",
        [company],
      );
      await sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$3),($2,$3)',
        [a, b, company],
      );
      await sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$1),($3,$4,1,20,'{}',$3)",
        [batchA, a, batchB, b],
      );
      await add('site.scan', a, 'failed', 'Reason A', 0.3);
      await add('site.scan', a, 'failed', 'Reason A', 0.2);
      await add('site.scan', a, 'failed', 'Other reason A', 0.1);
      await add('site.scan', b, 'done', '', 0);
      const paid = [
        await add('google.request', null, 'paused', 'Billing', 0, true, batchA),
        await add('google.request', null, 'paused', 'Billing', 0, true, batchA),
      ];
      await add('registry.match', a, 'failed', 'Old A', 30);
      const shared = await add('registry.match', null, 'queued', '');
      await add('company.score', a, 'queued', '');
      await add('company.score', b, 'queued', '');
      const total = Number(
        (await sonarPool.query('select count(*) from tasks')).rows[0].count,
      );
      const scoped = (await taskOverviewData({ campaignId: a }))!;
      expect(scoped.tasks).toHaveLength(8);
      expect(
        scoped.counts.reduce((sum, row) => sum + Number(row.count), 0),
      ).toBe(8);
      expect(scoped.batches.map((row) => row.id)).toEqual([batchA]);
      expect(
        scoped.failures
          .filter((row) => row.type === 'site.scan')
          .map((row) => row.reason_uk)
          .sort(),
      ).toEqual(['Other reason A', 'Reason A']);
      expect(
        scoped.failures.find((row) => row.reason_uk === 'Reason A')
          ?.repetitions,
      ).toBe(2);
      expect(
        scoped.failures
          .filter((row) => row.type === 'google.request')
          .map((row) => row.id)
          .sort(),
      ).toEqual(paid.sort());
      expect(scoped.olderFailures.map((row) => row.reason_uk)).toEqual([
        'Old A',
      ]);
      const other = (await taskOverviewData({ campaignId: b }))!;
      expect(other.tasks.map((row) => row.id)).toContain(shared);
      expect(other.tasks).toHaveLength(3);
      expect(other.failures).toEqual([]);
      const global = (await taskOverviewData())!;
      expect(
        global.counts.reduce((sum, row) => sum + Number(row.count), 0),
      ).toBe(total);
      expect(
        Number(
          (await sonarPool.query('select count(*) from tasks')).rows[0].count,
        ),
      ).toBe(total);
      expect(await taskOverviewData({ campaignId: randomUUID() })).toBeNull();
    } finally {
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from batches where id=any($1::uuid[])', [
        [batchA, batchB],
      ]);
      await sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [company],
      );
      await sonarPool.query('delete from companies where id=$1', [company]);
      await sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
        [a, b],
      ]);
      await sonarPool.query(
        "delete from settings where key='tasks.failure_visible_days'",
      );
      if (oldSetting)
        await sonarPool.query(
          "insert into settings(key,value) values('tasks.failure_visible_days',$1)",
          [JSON.stringify(oldSetting.value)],
        );
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
