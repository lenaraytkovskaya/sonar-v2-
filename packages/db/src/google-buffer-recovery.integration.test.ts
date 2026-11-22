import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@sonar/db/tasks', async (original) => ({
  ...(await original<object>()),
  enqueueBatchEnrichment: vi.fn(async () => 0),
}));
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'retains unconsumed paid places before a late known ID and consumes the buffer without another search',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { campaignProgress } = await import('./batches.js');
    const { runGoogleBatch } =
      await import('../../../apps/worker/src/google.js');
    const [campaign, paidBatch, nextBatch, paidTask] = Array.from(
      { length: 4 },
      () => randomUUID(),
    ) as [string, string, string, string];
    const prefix = randomUUID();
    const [newA, newB, duplicateKnown, elsewhere] = [
      'new-a',
      'new-b',
      'known',
      'elsewhere',
    ].map((value) => `${prefix}-${value}`) as [string, string, string, string];
    const config = {
      queries: ['q'],
      cities: ['c'],
      country_code: 'UA',
      language_code: 'uk',
      retentionDays: 30,
    };
    try {
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Buffer recovery','UA','uk',ARRAY['c'],ARRAY['q'],'',10,'{}','{}')",
        [campaign],
      );
      await sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key,status,requests,found_new) values($1,$3,1,1,$4,$1,'done',1,1),($2,$3,2,20,$4,$2,'queued',0,0)",
        [paidBatch, nextBatch, campaign, JSON.stringify(config)],
      );
      for (const placeId of [newA, duplicateKnown, elsewhere]) {
        const company = (
          await sonarPool.query(
            "insert into companies(place_id,name) values($1,'Already in CRM') returning id",
            [placeId],
          )
        ).rows[0].id;
        if (placeId !== elsewhere)
          await sonarPool.query(
            'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
            [campaign, company, paidBatch],
          );
      }
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,batch_id,payload,status,attempts) values($1,'google.request',$2,$3,'{\"page\":0}','done',1)",
        [paidTask, `google.request:${paidBatch}:0:0`, paidBatch],
      );
      await sonarPool.query(
        "insert into spend_events(task_id,service_code,units,cost_usd,meta) values($1,'google_places',1,0.035,$2)",
        [
          paidTask,
          JSON.stringify({
            response: {
              text: JSON.stringify({
                places: [newA, newB, duplicateKnown, elsewhere].map((id) => ({
                  id,
                })),
              }),
            },
          }),
        ],
      );
      const client = await sonarPool.connect();
      let recovered;
      try {
        recovered = await campaignProgress(client, campaign);
      } finally {
        client.release();
      }
      expect(recovered['["q","c","uk"]']).toMatchObject({
        pages: 1,
        exhausted: true,
        buffer: [{ id: newB }, { id: elsewhere }],
      });
      const never = vi.fn(async () => {
        throw Error('Must consume the paid buffer');
      });
      expect(await runGoogleBatch(nextBatch, never)).toMatchObject({
        status: 'done',
      });
      expect(never).not.toHaveBeenCalled();
      expect(
        (
          await sonarPool.query(
            'select c.place_id from campaign_companies cc join companies c on c.id=cc.company_id where cc.batch_id=$1 order by c.place_id',
            [nextBatch],
          )
        ).rows.map((row) => row.place_id),
      ).toEqual([newB, elsewhere].sort());
      expect(
        (
          await sonarPool.query(
            'select found_new,found_known,requests from batches where id=$1',
            [nextBatch],
          )
        ).rows[0],
      ).toMatchObject({ found_new: 1, found_known: 1, requests: 0 });
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as n from spend_events s join tasks t on t.id=s.task_id where t.batch_id=any($1::uuid[])',
            [[paidBatch, nextBatch]],
          )
        ).rows[0].n,
      ).toBe(1);
      const progress = (
        await sonarPool.query(
          'select google_progress from campaigns where id=$1',
          [campaign],
        )
      ).rows[0].google_progress;
      expect(progress['["q","c","uk"]']).toMatchObject({
        pages: 1,
        exhausted: true,
        buffer: [],
      });
    } finally {
      await sonarPool.query(
        "delete from activity_log where details->>'campaignId'=$1 or entity_id=any($2::text[])",
        [campaign, [campaign, paidBatch, nextBatch, paidTask]],
      );
      await sonarPool.query(
        'delete from spend_events where task_id in(select id from tasks where batch_id=any($1::uuid[]))',
        [[paidBatch, nextBatch]],
      );
      await sonarPool.query(
        'delete from tasks where batch_id=any($1::uuid[])',
        [[paidBatch, nextBatch]],
      );
      await sonarPool.query(
        'delete from campaign_companies where campaign_id=$1',
        [campaign],
      );
      await sonarPool.query('delete from companies where place_id like $1', [
        prefix + '%',
      ]);
      await sonarPool.query('delete from batches where campaign_id=$1', [
        campaign,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaign]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
