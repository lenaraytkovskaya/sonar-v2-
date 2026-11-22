import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'isolates malformed billing owners, preserves campaign caps, monthly reservations and paid replay',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { checkGooglePlanBudget, runBudgetedRequest } =
      await import('./budget.js');
    const [campaign, other, batch, otherBatch] = Array.from({ length: 4 }, () =>
      randomUUID(),
    );
    const ids: string[] = [];
    const original = (
      await sonarPool.query(
        "select value from settings where key='budget.monthly_usd'",
      )
    ).rows[0];
    const add = async (
      payload: object,
      batchId: string | null = null,
      reserve = 0,
    ) => {
      const id = randomUUID();
      ids.push(id);
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,payload,batch_id,result) values($1::uuid,'google.request',$1::text,$2,$3,$4)",
        [
          id,
          JSON.stringify(payload),
          batchId,
          JSON.stringify(
            reserve
              ? {
                  billingPending: true,
                  billingEstimate: reserve,
                  billingService: 'google_places',
                  billingAt: new Date().toISOString(),
                }
              : {},
          ),
        ],
      );
      return id;
    };
    const spend = async (id: string, cost: number) =>
      sonarPool.query(
        "insert into spend_events(service_code,task_id,units,cost_usd,meta) values('google_places',$1,1,$2,'{}')",
        [id, cost],
      );
    const plan = async (estimate: number) => {
      const client = await sonarPool.connect();
      try {
        await client.query('begin');
        await checkGooglePlanBudget(client, campaign!, estimate);
      } finally {
        await client.query('rollback');
        client.release();
      }
    };
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','1000') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'A','UA','uk','{}','{}','',0.10,'{}','{}'),($2,'B','UA','uk','{}','{}','',10,'{}','{}')",
        [campaign, other],
      );
      await sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$1),($3,$4,1,20,'{}',$3)",
        [batch, campaign, otherBatch, other],
      );
      // Invalid unrelated payloads still contribute to monthly usage, never to A.
      for (const key of [
        'campaignId',
        'messageId',
        'conversationId',
        'batchId',
      ]) {
        await spend(await add({ [key]: 'bad' }), 0.02);
        await add({ [key]: 'bad' }, null, 0.03);
      }
      await spend(await add({ campaignId: campaign }), 0.02);
      await add({ batchId: batch }, null, 0.03);
      // Actual batch ownership wins over a contradictory explicit campaign.
      await spend(await add({ campaignId: campaign }, otherBatch!), 1);
      await expect(plan(0.04)).resolves.toBeUndefined();
      await expect(plan(0.06)).rejects.toMatchObject({ scope: 'campaign' });
      const task = await add(
        { campaignId: 'bad', messageId: 'bad', conversationId: 'bad' },
        batch!,
      );
      const operation = vi.fn(async () => ({
        text: 'stub response',
        costUsd: 0.04,
        units: 1,
      }));
      await expect(
        runBudgetedRequest('google_places', 0.04, task, operation),
      ).resolves.toMatchObject({ text: 'stub response' });
      expect(operation).toHaveBeenCalledTimes(1);
      await expect(plan(0.02)).rejects.toMatchObject({ scope: 'campaign' });
      const unowned = await add({ campaignId: 'bad' });
      const never = vi.fn();
      await expect(
        runBudgetedRequest('google_places', 0.001, unowned, never),
      ).rejects.toThrow('requires campaign');
      expect(never).not.toHaveBeenCalled();
      const total = Number(
        (
          await sonarPool.query(`select sum(cost) as total from (
      select cost_usd as cost from spend_events where created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
      union all select (result->>'billingEstimate')::numeric from tasks where result->>'billingPending'='true'
      and (result->>'billingAt')::timestamptz >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC') usage`)
        ).rows[0].total,
      );
      await sonarPool.query(
        "update settings set value=$1 where key='budget.monthly_usd'",
        [JSON.stringify(total + 0.001)],
      );
      // A has remaining campaign budget; the monthly cap must include bad-owner reservations.
      await expect(plan(0.005)).rejects.toMatchObject({ scope: 'monthly' });
      await sonarPool.query(
        "update settings set value='0' where key='budget.monthly_usd'",
      );
      await expect(
        runBudgetedRequest('google_places', 99, task, never),
      ).resolves.toMatchObject({ text: 'stub response' });
      expect(never).not.toHaveBeenCalled();
    } finally {
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from batches where id=any($1::uuid[])', [
        [batch, otherBatch],
      ]);
      await sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
        [campaign, other],
      ]);
      await sonarPool.query(
        "delete from settings where key='budget.monthly_usd'",
      );
      if (original)
        await sonarPool.query(
          "insert into settings(key,value) values('budget.monthly_usd',$1)",
          [JSON.stringify(original.value)],
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
