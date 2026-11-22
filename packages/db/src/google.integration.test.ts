import { afterAll, expect, it, vi } from 'vitest';
import { PaidHttpError, contactFields } from '@sonar/core';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'Google stubs: pagination, dedupe, batch cap, campaign reserve, replay, unknown billing and 3-page ceiling',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { createBatch } = await import('./batches.js');
    const { runGoogleBatch } =
      await import('../../../apps/worker/src/google.js');
    const prefix = randomUUID();
    const campaigns: string[] = [];
    const { rows: original } = await sonarPool.query(
      "select key,value from settings where key='budget.monthly_usd'",
    );
    const campaign = async (
      budget = 0.5,
      channels: Record<string, boolean> = {},
    ) => {
      const {
        rows: [c],
      } = await sonarPool.query(
        `insert into campaigns(name,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,scoring_weights) values($1,'UA','uk',ARRAY['Київ'],ARRAY['СТО'],'',20,$2,$3,'{}') returning id`,
        [prefix, budget, JSON.stringify(channels)],
      );
      campaigns.push(c.id);
      return c.id;
    };
    const place = (n: number) => ({
      id: `${prefix}-${n}`,
      displayName: { text: `Company ${n}` },
      websiteUri: 'https://www.example.com',
      nationalPhoneNumber: '044 222 33 44',
      businessStatus: 'OPERATIONAL',
      regularOpeningHours: { weekdayDescriptions: ['Monday: 9–18'] },
    });
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','100') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        "insert into companies(place_id,name) values($1,'Known')",
        [place(100).id],
      );
      await expect(
        createBatch(await campaign(0.035), null, randomUUID(), false, false),
      ).rejects.toThrow('бюджет');
      const multilingual = await campaign();
      await sonarPool.query(
        "update campaigns set queries=ARRAY['q1','q2'],cities=ARRAY['c1','c2'],language_codes=ARRAY['uk','en'] where id=$1",
        [multilingual],
      );
      const languageBatch = await createBatch(
        multilingual,
        null,
        randomUUID(),
        true,
        false,
      );
      const languageSearch = vi.fn(
        async (input: { textQuery: string; languageCode: string }) => ({
          places: [
            place(9000),
            {
              ...place(9001),
              id: `${prefix}-${input.textQuery}-${input.languageCode}`,
            },
          ],
        }),
      );
      await runGoogleBatch(languageBatch.id, languageSearch);
      expect(languageSearch).toHaveBeenCalledTimes(8);
      expect(
        new Set(
          languageSearch.mock.calls.map(
            ([input]) => `${input.textQuery}:${input.languageCode}`,
          ),
        ).size,
      ).toBe(8);
      expect(
        (
          await sonarPool.query(
            'select found_new+found_known as found from batches where id=$1',
            [languageBatch.id],
          )
        ).rows[0].found,
      ).toBe(9);
      expect(
        (
          await sonarPool.query(
            "select count(*)::int as n from company_facts f join campaign_companies cc on cc.company_id=f.company_id where cc.batch_id=$1 and f.kind='google_opening_hours' and f.source='google' and f.expires_at>f.found_at",
            [languageBatch.id],
          )
        ).rows[0].n,
      ).toBe(9);
      const staleProfile = {
        id: 'basic',
        name: 'Old',
        fields: ['places.id', 'nextPageToken'],
        priceUsd: 0.001,
        sku: 'Text Search Pro',
      };
      for (const id of ['basic', 'contacts']) {
        const frozenProfile =
          id === 'basic'
            ? staleProfile
            : {
                ...staleProfile,
                id,
                fields: ['places.id', 'places.websiteUri', 'nextPageToken'],
                sku: 'Text Search Enterprise',
              };
        const staleBatch = await createBatch(
          await campaign(),
          null,
          randomUUID(),
          false,
          false,
        );
        await sonarPool.query(
          "update batches set config=jsonb_set(config,'{profile}',$2::jsonb) where id=$1",
          [staleBatch.id, JSON.stringify(frozenProfile)],
        );
        const configuredProfile = (
          await sonarPool.query(
            "select value from settings where key='google.field_profiles'",
          )
        ).rows[0].value.find(
          (profile: { id: string }) => profile.id === 'contacts',
        );
        const currentSearch = vi.fn(
          async (
            _input: unknown,
            profile: { fields: string[]; priceUsd: number },
          ) => {
            expect(profile.fields).toEqual(
              expect.arrayContaining(contactFields),
            );
            expect(profile.priceUsd).toBe(configuredProfile.priceUsd);
            return { places: [] };
          },
        );
        await runGoogleBatch(staleBatch.id, currentSearch);
        expect(currentSearch).toHaveBeenCalledTimes(1);
        expect(
          Number(
            (
              await sonarPool.query(
                'select cost_usd from spend_events s join tasks t on t.id=s.task_id where t.batch_id=$1',
                [staleBatch.id],
              )
            ).rows[0].cost_usd,
          ),
        ).toBe(configuredProfile.priceUsd);
        expect(
          (
            await sonarPool.query('select config from batches where id=$1', [
              staleBatch.id,
            ])
          ).rows[0].config.profile,
        ).toEqual(frozenProfile);
      }
      const blockedCampaign = await campaign(0.5, { email: true });
      await expect(
        createBatch(blockedCampaign, null, randomUUID(), false, false),
      ).rejects.toThrow('Заповніть пропозицію кампанії');
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as count from batches where campaign_id=$1',
            [blockedCampaign],
          )
        ).rows[0].count,
      ).toBe(0);
      await sonarPool.query(
        "update campaigns set offer='Пропозиція для ніші' where id=$1",
        [blockedCampaign],
      );
      expect(
        await createBatch(blockedCampaign, null, randomUUID(), false, false),
      ).toHaveProperty('id');
      const c = await campaign();
      const b = await createBatch(c, null, randomUUID(), false, false);
      const search = vi.fn(async (input: { pageToken?: string }) =>
        input.pageToken
          ? { places: Array.from({ length: 20 }, (_, i) => place(i + 10)) }
          : {
              places: [
                ...Array.from({ length: 10 }, (_, i) => place(i)),
                place(0),
                place(100),
                { ...place(200), businessStatus: 'CLOSED_PERMANENTLY' },
              ],
              nextPageToken: 'next',
            },
      );
      expect(await runGoogleBatch(b.id, search)).toMatchObject({
        status: 'done',
      });
      expect(search).toHaveBeenCalledTimes(2);
      expect(search.mock.calls[1]![0].pageToken).toBe('next');
      const result = (
        await sonarPool.query('select * from batches where id=$1', [b.id])
      ).rows[0];
      expect(result.found_new).toBe(19);
      expect(result.found_known).toBe(1);
      expect(result.requests).toBe(2);
      expect(Number(result.cost_usd)).toBe(0.07);
      expect(
        (
          await sonarPool.query(
            "select normalized from contacts where kind='phone' and company_id in(select company_id from campaign_companies where batch_id=$1)",
            [b.id],
          )
        ).rows.every((r) => r.normalized === '+380442223344'),
      ).toBe(true);
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as n from campaign_companies where batch_id=$1',
            [b.id],
          )
        ).rows[0].n,
      ).toBe(20);
      await runGoogleBatch(b.id, search);
      expect(search).toHaveBeenCalledTimes(2);
      const again = await createBatch(c, null, randomUUID(), false, false);
      const noRequest = vi.fn(async () => {
        throw Error('Buffer must be consumed first');
      });
      await runGoogleBatch(again.id, noRequest);
      expect(noRequest).not.toHaveBeenCalled();
      expect(
        (
          await sonarPool.query(
            'select found_new,found_known from batches where id=$1',
            [again.id],
          )
        ).rows[0],
      ).toEqual({ found_new: 11, found_known: 0 });
      expect(await createBatch(c, null, randomUUID(), false, false)).toEqual({
        exhausted: true,
      });
      await sonarPool.query(
        "update campaigns set cities=ARRAY['Львів','Київ'] where id=$1",
        [c],
      );
      const newCity = await createBatch(c, null, randomUUID(), false, false);
      const citySearch = vi.fn(async () => ({ places: [place(300)] }));
      await runGoogleBatch(newCity.id, citySearch);
      expect(citySearch).toHaveBeenCalledTimes(1);
      expect(citySearch.mock.calls[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ textQuery: 'СТО Львів' }),
        ]),
      );
      const resumeCampaign = await campaign();
      const resumeFirst = await createBatch(
        resumeCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      const continuation = vi.fn(async (input: { pageToken?: string }) => ({
        places: Array.from({ length: 20 }, (_, i) =>
          place(1000 + i + (input.pageToken ? 20 : 0)),
        ),
        ...(input.pageToken ? {} : { nextPageToken: 'saved-next' }),
      }));
      await runGoogleBatch(resumeFirst.id, continuation);
      const resumeSecond = await createBatch(
        resumeCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      await runGoogleBatch(resumeSecond.id, continuation);
      expect(continuation).toHaveBeenCalledTimes(2);
      expect(continuation.mock.calls.map(([input]) => input.pageToken)).toEqual(
        [undefined, 'saved-next'],
      );
      const rejectedCampaign = await campaign();
      const rejectedFirst = await createBatch(
        rejectedCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      await runGoogleBatch(rejectedFirst.id, async () => ({
        places: Array.from({ length: 20 }, (_, i) => place(1100 + i)),
        nextPageToken: 'expired',
      }));
      const rejectedSecond = await createBatch(
        rejectedCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      const reject = vi.fn(async (input: { pageToken?: string }) => {
        expect(input.pageToken).toBe('expired');
        throw new PaidHttpError(400);
      });
      expect(await runGoogleBatch(rejectedSecond.id, reject)).toMatchObject({
        status: 'done',
      });
      expect(reject).toHaveBeenCalledTimes(1);
      expect(
        (
          await sonarPool.query('select reason_uk from batches where id=$1', [
            rejectedSecond.id,
          ])
        ).rows[0].reason_uk,
      ).toContain('400');
      expect(
        await createBatch(rejectedCampaign, null, randomUUID(), false, false),
      ).toEqual({ exhausted: true });
      const forbidden = await createBatch(
        await campaign(0.5),
        null,
        randomUUID(),
        false,
        false,
      );
      expect(
        await runGoogleBatch(forbidden.id, async () => {
          throw new PaidHttpError(403);
        }),
      ).toMatchObject({ status: 'paused', reasonCode: 'http_403' });
      const failedTask = (
        await sonarPool.query('select * from tasks where batch_id=$1', [
          forbidden.id,
        ])
      ).rows[0];
      expect(failedTask.status).toBe('failed');
      expect(failedTask.result.billingPending).toBe(false);
      expect(
        Number(
          (
            await sonarPool.query(
              'select cost_usd from spend_events where task_id=$1',
              [failedTask.id],
            )
          ).rows[0].cost_usd,
        ),
      ).toBe(0);
      expect(
        await runGoogleBatch(forbidden.id, async () => ({
          places: [place(1200)],
        })),
      ).toMatchObject({ status: 'done' });
      const { reconcileBilling } = await import('./budget.js');
      for (const charged of [true, false]) {
        const timed = await createBatch(
          await campaign(),
          null,
          randomUUID(),
          false,
          false,
        );
        const timeout = vi.fn(async () => {
          throw Error('timeout');
        });
        expect(await runGoogleBatch(timed.id, timeout)).toMatchObject({
          reasonCode: 'billing_uncertain',
        });
        const task = (
          await sonarPool.query('select * from tasks where batch_id=$1', [
            timed.id,
          ])
        ).rows[0];
        expect(await reconcileBilling(task.id, charged, null)).toBe(true);
        expect(await reconcileBilling(task.id, charged, null)).toBe(false);
        expect(
          Number(
            (
              await sonarPool.query(
                'select cost_usd from spend_events where task_id=$1',
                [task.id],
              )
            ).rows[0].cost_usd,
          ),
        ).toBe(charged ? 0.035 : 0);
        expect(
          await runGoogleBatch(timed.id, async () => ({ places: [] })),
        ).toMatchObject({ status: 'done' });
        expect(timeout).toHaveBeenCalledTimes(1);
      }
      const duplicate = await createBatch(
        await campaign(),
        null,
        randomUUID(),
        false,
        false,
      );
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ongoing = runGoogleBatch(duplicate.id, async () => {
        started();
        await gate;
        return { places: [] };
      });
      await entered;
      expect(
        await runGoogleBatch(duplicate.id, async () => {
          throw Error('duplicate');
        }),
      ).toMatchObject({ status: 'skipped', reasonCode: 'batch_busy' });
      release();
      await ongoing;
      const limit = await createBatch(
        await campaign(0.5),
        null,
        randomUUID(),
        false,
        false,
      );
      await sonarPool.query(
        'update campaigns set budget_usd=0.035 where id=$1',
        [limit.campaign_id],
      );
      const limited = vi.fn(async () => ({
        places: [place(400)],
        nextPageToken: 'next',
      }));
      expect(await runGoogleBatch(limit.id, limited)).toMatchObject({
        status: 'paused',
        reasonCode: 'budget_exceeded',
      });
      expect(limited).toHaveBeenCalledTimes(1);
      const concurrentCampaign = await campaign(0.5);
      const first = await createBatch(
        concurrentCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      const second = await createBatch(
        concurrentCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      await sonarPool.query(
        'update campaigns set budget_usd=0.035 where id=$1',
        [concurrentCampaign],
      );
      const parallel = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { places: [] };
      });
      const statuses = await Promise.all([
        runGoogleBatch(first.id, parallel),
        runGoogleBatch(second.id, parallel),
      ]);
      expect(parallel).toHaveBeenCalledTimes(1);
      expect(statuses.filter((r) => r.status === 'skipped')).toHaveLength(1);
      const three = await createBatch(
        await campaign(),
        null,
        randomUUID(),
        false,
        false,
      );
      const pages = vi.fn(async () => ({ places: [], nextPageToken: 'more' }));
      await runGoogleBatch(three.id, pages);
      expect(pages).toHaveBeenCalledTimes(3);

      const recovery = await createBatch(
        await campaign(),
        null,
        randomUUID(),
        false,
        false,
      );
      const {
        rows: [paidTask],
      } = await sonarPool.query(
        "insert into tasks(type,idempotency_key,batch_id) values('google.request',$1,$2) returning id",
        [`google.request:${recovery.id}:0:0`, recovery.id],
      );
      const { runBudgetedRequest } = await import('./budget.js');
      await runBudgetedRequest(
        'google_places',
        0.035,
        paidTask.id,
        async () => ({
          id: paidTask.id,
          model: 'stub',
          text: JSON.stringify({ places: [place(600)] }),
          costUsd: 0.035,
          units: 1,
        }),
      );
      await sonarPool.query(
        "update batches set config=jsonb_set(config,'{profile}',$2::jsonb) where id=$1",
        [recovery.id, JSON.stringify(staleProfile)],
      );
      const never = vi.fn(async () => {
        throw Error('Must reuse paid response');
      });
      expect(await runGoogleBatch(recovery.id, never)).toMatchObject({
        status: 'done',
      });
      expect(never).not.toHaveBeenCalled();
      expect(
        (
          await sonarPool.query('select found_new from batches where id=$1', [
            recovery.id,
          ])
        ).rows[0].found_new,
      ).toBe(1);
      const malformed = await createBatch(
        await campaign(),
        null,
        randomUUID(),
        false,
        false,
      );
      const malformedSearch = vi.fn(async () => '{invalid json');
      expect(await runGoogleBatch(malformed.id, malformedSearch)).toMatchObject(
        {
          status: 'paused',
          reasonCode: 'google_response_invalid',
        },
      );
      const noSecondCharge = vi.fn(async () => {
        throw Error('Saved response should be replayed');
      });
      expect(await runGoogleBatch(malformed.id, noSecondCharge)).toMatchObject({
        status: 'paused',
        reasonCode: 'google_response_invalid',
      });
      expect(malformedSearch).toHaveBeenCalledTimes(1);
      expect(noSecondCharge).not.toHaveBeenCalled();
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as n from spend_events s join tasks t on t.id=s.task_id where t.batch_id=$1',
            [malformed.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await sonarPool.query('select reason_uk from batches where id=$1', [
            malformed.id,
          ])
        ).rows[0].reason_uk,
      ).toContain('Відповідь Google отримано й оплачено');
      const missingCampaign = await campaign();
      const missing = await createBatch(
        missingCampaign,
        null,
        randomUUID(),
        false,
        false,
      );
      await sonarPool.query('update batches set requests=1 where id=$1', [
        missing.id,
      ]);
      await expect(
        createBatch(missingCampaign, null, randomUUID(), false, false),
      ).rejects.toThrow('Першу сторінку повторно не запитано');
      const failure = await createBatch(
        await campaign(),
        null,
        randomUUID(),
        false,
        false,
      );
      const unknown = vi.fn(async () => {
        throw Error('timeout');
      });
      expect(await runGoogleBatch(failure.id, unknown)).toMatchObject({
        status: 'paused',
      });
      expect(await runGoogleBatch(failure.id, unknown)).toMatchObject({
        status: 'paused',
        reasonCode: 'billing_uncertain',
      });
      expect(unknown).toHaveBeenCalledTimes(1);
      expect(
        (
          await sonarPool.query('select requests from batches where id=$1', [
            failure.id,
          ])
        ).rows[0].requests,
      ).toBe(1);
    } finally {
      await sonarPool.query(
        'delete from activity_log where entity_id in(select id::text from tasks where batch_id in(select id from batches where campaign_id=any($1::uuid[])))',
        [campaigns],
      );
      await sonarPool.query(
        'delete from spend_events where task_id in (select t.id from tasks t join batches b on b.id=t.batch_id where b.campaign_id=any($1::uuid[]))',
        [campaigns],
      );
      await sonarPool.query(
        'delete from tasks where batch_id in(select id from batches where campaign_id=any($1::uuid[]))',
        [campaigns],
      );
      await sonarPool.query(
        "delete from activity_log where details->>'campaignId'=any($1::text[]) or entity_id=any($1::text[])",
        [campaigns],
      );
      await sonarPool.query(
        'delete from company_facts where company_id in(select id from companies where place_id like $1)',
        [prefix + '%'],
      );
      await sonarPool.query(
        'delete from contacts where company_id in(select id from companies where place_id like $1)',
        [prefix + '%'],
      );
      await sonarPool.query(
        'delete from campaign_companies where campaign_id=any($1::uuid[])',
        [campaigns],
      );
      await sonarPool.query('delete from companies where place_id like $1', [
        prefix + '%',
      ]);
      await sonarPool.query(
        'delete from batches where campaign_id=any($1::uuid[])',
        [campaigns],
      );
      await sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
        campaigns,
      ]);
      await sonarPool.query(
        "delete from settings where key='budget.monthly_usd'",
      );
      for (const r of original)
        await sonarPool.query('insert into settings(key,value) values($1,$2)', [
          r.key,
          JSON.stringify(r.value),
        ]);
    }
  },
  20000,
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
