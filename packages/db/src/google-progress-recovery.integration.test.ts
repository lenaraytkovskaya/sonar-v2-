import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { plannedGoogleRequests } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'recovers global page indexes across multilingual batches and retries, never a fourth page or a lost receipt',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { campaignProgress, createBatch, ContinuationUnavailable } =
      await import('./batches.js');
    const { runGoogleBatch } =
      await import('../../../apps/worker/src/google.js');
    const [campaign, product] = [randomUUID(), randomUUID()];
    const batches: string[] = [],
      tasks: string[] = [];
    const config = {
      queries: ['q'],
      cities: ['c'],
      country_code: 'UA',
      language_code: 'uk',
      language_codes: ['uk', 'en'],
      retentionDays: 30,
    };
    const batch = async (number: number, requests: number) => {
      const id = randomUUID();
      batches.push(id);
      await sonarPool.query(
        'insert into batches(id,campaign_id,number,size,config,request_key,requests,cursor) values($1,$2,$3,20,$4,$1,$5,\'{"pair":1}\')',
        [id, campaign, number, JSON.stringify(config), requests],
      );
      return id;
    };
    const receipt = async (
      batchId: string,
      pair: number,
      page: number,
      token?: string,
      retry = false,
      payloadPage = true,
    ) => {
      const id = randomUUID();
      tasks.push(id);
      const key = `google.request:${batchId}:${pair}:${page}${retry ? ':retry:1' : ''}`;
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,batch_id,payload,status,attempts) values($1,'google.request',$2,$3,$4,'done',1)",
        [id, key, batchId, JSON.stringify(payloadPage ? { page } : {})],
      );
      await sonarPool.query(
        "insert into spend_events(task_id,service_code,units,cost_usd,meta) values($1,'google_places',1,0.035,$2)",
        [
          id,
          JSON.stringify({
            response: {
              text: JSON.stringify({
                places: [],
                ...(token ? { nextPageToken: token } : {}),
              }),
            },
          }),
        ],
      );
      return id;
    };
    const recover = async () => {
      const client = await sonarPool.connect();
      try {
        return await campaignProgress(client, campaign);
      } finally {
        client.release();
      }
    };
    try {
      await sonarPool.query(
        "insert into products(id,name) values($1,'Recovery product')",
        [product],
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,language_codes,cities,queries,offer,budget_usd,channels,scoring_weights,product_id) values($1,'Recovery','UA','uk',ARRAY['uk','en'],ARRAY['c'],ARRAY['q'],'',100,'{}','{}',$2)",
        [campaign, product],
      );
      const first = await batch(1, 2);
      await receipt(first, 0, 0); // uk exhausted in batch one, never requested in batch two.
      await receipt(first, 1, 0, 'en-page-1', false, false); // Legacy key fallback.
      const second = await batch(2, 2);
      await receipt(second, 1, 1, 'en-page-2');
      await receipt(second, 1, 1, 'en-page-2', true); // Same global page, not a third page.
      const recovered = await recover();
      expect(recovered['["q","c","uk"]']).toMatchObject({
        pages: 1,
        exhausted: true,
      });
      expect(recovered['["q","c","en"]']).toMatchObject({
        pages: 2,
        token: 'en-page-2',
        exhausted: false,
      });
      expect(plannedGoogleRequests(config, recovered)).toBe(1);
      const third = await batch(3, 1);
      const last = await receipt(third, 1, 2, 'must-not-request-page-4');
      await sonarPool.query(
        "update campaigns set google_progress='{}' where id=$1",
        [campaign],
      );
      const complete = await recover();
      expect(complete['["q","c","en"]']).toMatchObject({
        pages: 3,
        token: 'must-not-request-page-4',
        exhausted: true,
      });
      expect(plannedGoogleRequests(config, complete)).toBe(0);
      expect(
        await createBatch(campaign, null, randomUUID(), false, false),
      ).toEqual({ exhausted: true });
      const never = vi.fn(async () => {
        throw Error('Never refetch paid pages');
      });
      expect(await runGoogleBatch(third, never)).toMatchObject({
        status: 'done',
      });
      expect(never).not.toHaveBeenCalled();
      // Missing paid responses, including a manually confirmed charge, are unsafe.
      for (const meta of [
        {},
        { reconciliation: 'charged' },
        { reconciliation: 'unknown' },
        { error: { status: 500 } },
      ]) {
        await sonarPool.query(
          "update campaigns set google_progress='{}' where id=$1",
          [campaign],
        );
        await sonarPool.query(
          'update spend_events set meta=$2,cost_usd=0.035 where task_id=$1',
          [last, JSON.stringify(meta)],
        );
        await sonarPool.query(
          "update batches set status='queued' where id=$1",
          [third],
        );
        await expect(recover()).rejects.toBeInstanceOf(ContinuationUnavailable);
        await expect(runGoogleBatch(third, never)).rejects.toThrow(
          'Першу сторінку повторно не запитано',
        );
        expect(never).not.toHaveBeenCalled();
      }
      // Confirmed zero-cost attempts retain only the previously proven page/token.
      for (const meta of [
        { reconciliation: 'not_charged' },
        { error: { status: 500 } },
      ]) {
        await sonarPool.query(
          "update campaigns set google_progress='{}' where id=$1",
          [campaign],
        );
        await sonarPool.query(
          'update spend_events set meta=$2,cost_usd=0 where task_id=$1',
          [last, JSON.stringify(meta)],
        );
        const prior = await recover();
        expect(prior['["q","c","en"]']).toMatchObject({
          pages: 2,
          token: 'en-page-2',
          exhausted: false,
        });
        expect(plannedGoogleRequests(config, prior)).toBe(1);
      }
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as n from spend_events where task_id=any($1::uuid[])',
            [tasks],
          )
        ).rows[0].n,
      ).toBe(5);
    } finally {
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [[campaign, ...batches, ...tasks]],
      );
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [tasks],
      );
      await sonarPool.query(
        'delete from tasks where batch_id=any($1::uuid[])',
        [batches],
      );
      await sonarPool.query('delete from batches where campaign_id=$1', [
        campaign,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaign]);
      await sonarPool.query('delete from products where id=$1', [product]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
