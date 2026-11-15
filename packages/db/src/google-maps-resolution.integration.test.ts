import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GoogleCompanyPayload } from '../../../apps/worker/src/google-company.js';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let run: typeof import('../../../apps/worker/src/google-company.js').runGoogleCompany;
let save: typeof import('./manual-source.js').saveManualSource;
let retry: typeof import('./tasks.js').retryTask;
let admin: import('pg-boss').PgBoss;
let userId: string, campaignId: string;
const companies: string[] = [];
const placeId = 'ChIJSyntheticResolvedPlace01';
const share = 'https://maps.app.goo.gl/SyntheticShare?g_st=ic';
const full =
  'https://www.google.com/maps/place/Synthetic+Company/@1,2,17z/data=!1s0x123:0x456!8m2!3d1!4d2';
async function create(sourceUrl = share) {
  const id = randomUUID();
  companies.push(id);
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$2,'Synthetic Maps company','UA')",
    [id, `manual:${id}`],
  );
  await db.sonarPool.query(
    'insert into campaign_companies(company_id,campaign_id) values($1,$2)',
    [id, campaignId],
  );
  const input = {
    requestId: randomUUID(),
    source: 'googleMaps' as const,
    value: sourceUrl,
    expected: null,
  };
  const [first, duplicate] = await Promise.all([
    save(id, input, userId),
    save(id, input, userId),
  ]);
  expect(first!.tasks[0].id).toBe(duplicate!.tasks[0].id);
  const taskId = first!.tasks[0].id;
  const payload = (
    await db.sonarPool.query('select payload from tasks where id=$1', [taskId])
  ).rows[0].payload as GoogleCompanyPayload;
  return { id, taskId, payload };
}
async function receipts(companyId: string) {
  return (
    await db.sonarPool.query(
      'select t.type,t.payload,s.cost_usd,s.meta from tasks t join spend_events s on s.task_id=t.id where t.subject_id=$1 order by s.created_at',
      [companyId],
    )
  ).rows;
}
const success = () =>
  Response.json({ entities: [{ place: `places/${placeId}` }] });
const details = () =>
  Response.json({
    id: placeId,
    displayName: { text: 'Resolved source name' },
    formattedAddress: 'Source address',
    websiteUri: 'https://example.com/',
  });
describe.skipIf(!enabled)('official Google Maps URL resolution', () => {
  beforeAll(async () => {
    db = await import('./index.js');
    run = (await import('../../../apps/worker/src/google-company.js'))
      .runGoogleCompany;
    save = (await import('./manual-source.js')).saveManualSource;
    retry = (await import('./tasks.js')).retryTask;
    const { PgBoss } = await import('pg-boss');
    admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('google.company');
    userId = (
      await db.sonarPool.query(
        "insert into users(email,name,password_hash) values($1,'Maps synthetic','unused') returning id",
        [`${randomUUID()}@example.test`],
      )
    ).rows[0].id;
    campaignId = (
      await db.sonarPool.query(
        "insert into campaigns(name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values('Maps synthetic','UA','uk','{}','{}','',10,'{}','{}') returning id",
      )
    ).rows[0].id;
  });
  it.each([full, share])(
    'resolves %s once, preserves the source and keeps free/paid receipts separate',
    async (sourceUrl) => {
      const task = await create(sourceUrl);
      const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (url === 'https://mapstools.googleapis.com/v1:resolveMapsUrls') {
          expect(JSON.parse(String(init!.body))).toEqual({ urls: [sourceUrl] });
          return success();
        }
        expect(url).toBe(`https://places.googleapis.com/v1/places/${placeId}`);
        return details();
      });
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        status: 'done',
        result: { placeId, sourceUrl },
      });
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        status: 'done',
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        (await receipts(task.id)).map((row) => [row.type, row.cost_usd]),
      ).toEqual([
        ['google.resolve', '0.0000000000'],
        ['google.company', '0.0200000000'],
      ]);
      expect(
        (
          await db.sonarPool.query(
            'select name,google_maps_uri,place_id from companies where id=$1',
            [task.id],
          )
        ).rows[0],
      ).toEqual({
        name: 'Synthetic Maps company',
        google_maps_uri: sourceUrl,
        place_id: `manual:${task.id}`,
      });
      expect(
        (
          await db.sonarPool.query(
            "select source_url from company_facts where company_id=$1 and kind='google_place'",
            [task.id],
          )
        ).rows[0].source_url,
      ).toBe(sourceUrl);
    },
  );
  it.each([
    [
      { entities: [{}], failedRequests: { 0: { code: 3 } } },
      'google_resolve_no_place',
    ],
    [
      { entities: [{}], failedRequests: { 0: { code: 13 } } },
      'google_resolve_internal',
    ],
    [
      { entities: [{ place: `places/${placeId}` }, { place: 'places/Other' }] },
      'google_resolve_invalid',
    ],
    [{ entities: [{}] }, 'google_resolve_no_place'],
    [{ invalid: true }, 'google_resolve_invalid'],
  ] as const)(
    'never pays for Details when resolution is not a unique Place ID: %j',
    async (body, code) => {
      const task = await create();
      const fetcher = vi
        .fn()
        .mockImplementation(async () => Response.json(body));
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        reasonCode: code,
      });
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        reasonCode: code,
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
        '0.0000000000',
      ]);
    },
  );
  it.each([403, 429, 503])(
    'retries resolver HTTP %s with a new resolution version and keeps the old receipt',
    async (status) => {
      const task = await create();
      let calls = 0;
      const fetcher = vi.fn(async (url: unknown) => {
        calls++;
        return calls === 1
          ? new Response('', { status })
          : String(url).includes('resolveMapsUrls')
            ? success()
            : details();
      });
      const first = await run(task.payload, task.taskId, fetcher);
      expect(first).toMatchObject({
        status: 'paused',
        reasonCode:
          status === 403 ? 'google_resolve_activation' : 'google_resolve_http',
      });
      if (status === 403)
        expect('reasonUk' in first && first.reasonUk).toContain(
          'Maps Experience agent tools API',
        );
      await db.sonarPool.query("update tasks set status='paused' where id=$1", [
        task.taskId,
      ]);
      await db.sonarPool.query(
        "update pgboss.job set state='failed' where data->>'taskId'=$1",
        [task.taskId],
      );
      expect(
        (
          await Promise.all([
            retry(task.taskId, userId),
            retry(task.taskId, userId),
          ])
        ).filter(Boolean),
      ).toHaveLength(1);
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        reasonCode: 'source_changed',
      });
      expect(calls).toBe(1);
      const current = (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          task.taskId,
        ])
      ).rows[0].payload;
      expect(current.resolveVersion).toBe(1);
      expect(
        (
          await db.sonarPool.query(
            "select data->>'version' as version from pgboss.job where data->>'taskId'=$1 and state='created'",
            [task.taskId],
          )
        ).rows,
      ).toEqual([{ version: '1' }]);
      expect(await run(current, task.taskId, fetcher)).toMatchObject({
        status: 'done',
      });
      expect(calls).toBe(3);
      expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
        '0.0000000000',
        '0.0000000000',
        '0.0200000000',
      ]);
    },
  );
  it('keeps separate source snapshots when a full URL is replaced by a Share URL for the same place', async () => {
    const task = await create(full);
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).includes('resolveMapsUrls') ? success() : details(),
    );
    expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
      status: 'done',
    });
    await db.sonarPool.query("update tasks set status='done' where id=$1", [
      task.taskId,
    ]);
    const next = await save(
      task.id,
      {
        requestId: randomUUID(),
        source: 'googleMaps',
        value: share,
        expected: full,
      },
      userId,
    );
    const nextId = next!.tasks[0].id;
    const payload = (
      await db.sonarPool.query('select payload from tasks where id=$1', [
        nextId,
      ])
    ).rows[0].payload;
    expect(await run(payload, nextId, fetcher)).toMatchObject({
      status: 'done',
    });
    expect(
      (
        await db.sonarPool.query(
          "select source_url from company_facts where company_id=$1 and kind='google_place' order by found_at",
          [task.id],
        )
      ).rows,
    ).toEqual([{ source_url: full }, { source_url: share }]);
    expect(
      (
        await db.sonarPool.query(
          "select id from company_facts where company_id=$1 and kind='manual_source'",
          [task.id],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('honors the campaign budget after the free resolution and before paid HTTP', async () => {
    const task = await create();
    await db.sonarPool.query(
      'update campaigns set budget_usd=0.001 where id=$1',
      [campaignId],
    );
    const fetcher = vi.fn(async () => success());
    try {
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        status: 'paused',
        reasonCode: 'budget_exceeded',
      });
    } finally {
      await db.sonarPool.query(
        'update campaigns set budget_usd=10 where id=$1',
        [campaignId],
      );
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
      '0.0000000000',
    ]);
  });
  it.each(['source', 'version'] as const)(
    'drops a stale %s after resolution before Details',
    async (change) => {
      const task = await create();
      const fetcher = vi.fn(async () => {
        if (change === 'source')
          await db.sonarPool.query(
            "update companies set google_maps_uri='https://maps.app.goo.gl/Other' where id=$1",
            [task.id],
          );
        else
          await db.sonarPool.query(
            'update tasks set payload=payload||\'{"resolveVersion":1}\'::jsonb where id=$1',
            [task.taskId],
          );
        return success();
      });
      expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
        status: 'skipped',
        reasonCode: 'source_changed',
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
        '0.0000000000',
      ]);
    },
  );
  it('accounts Details but refuses to persist a source replaced during the paid response', async () => {
    const task = await create();
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('resolveMapsUrls')) return success();
      await db.sonarPool.query(
        "update companies set google_maps_uri='https://maps.app.goo.gl/Other' where id=$1",
        [task.id],
      );
      return details();
    });
    expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
      reasonCode: 'source_changed',
    });
    expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
      '0.0000000000',
      '0.0200000000',
    ]);
    expect(
      (
        await db.sonarPool.query(
          "select id from company_facts where company_id=$1 and kind='google_place'",
          [task.id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('preserves uncertain paid Details protection after a successful free resolution', async () => {
    const task = await create();
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).includes('resolveMapsUrls')) return success();
      throw Error('synthetic lost paid response');
    });
    expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
      status: 'paused',
      reasonCode: 'billing_uncertain',
    });
    await db.sonarPool.query("update tasks set status='paused' where id=$1", [
      task.taskId,
    ]);
    expect(await retry(task.taskId, userId)).toBe(false);
    expect(await run(task.payload, task.taskId, fetcher)).toMatchObject({
      reasonCode: 'billing_uncertain',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await receipts(task.id)).map((row) => row.cost_usd)).toEqual([
      '0.0000000000',
    ]);
    expect(
      (
        await db.sonarPool.query('select result from tasks where id=$1', [
          task.taskId,
        ])
      ).rows[0].result.billingPending,
    ).toBe(true);
  });
  it('blocks explicit retry while the tracked worker owns the Google task lease', async () => {
    const task = await create(),
      client = await db.sonarPool.connect();
    await db.sonarPool.query("update tasks set status='failed' where id=$1", [
      task.taskId,
    ]);
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1,0))', [
        `google.company:${task.taskId}`,
      ]);
      expect(await retry(task.taskId, userId)).toBe(false);
    } finally {
      await client.query('select pg_advisory_unlock_all()');
      client.release();
    }
    expect(await retry(task.taskId, userId)).toBe(true);
  });
  afterAll(async () => {
    if (!db) return;
    await db.sonarPool.query(
      "delete from pgboss.job where data->>'taskId' in(select id::text from tasks where subject_id=any($1::text[]))",
      [companies],
    );
    await db.sonarPool.query(
      'delete from spend_events where task_id in(select id from tasks where subject_id=any($1::text[]))',
      [companies],
    );
    await db.sonarPool.query(
      'delete from tasks where subject_id=any($1::text[])',
      [companies],
    );
    await db.sonarPool.query('delete from activity_log where user_id=$1', [
      userId,
    ]);
    await db.sonarPool.query(
      'delete from company_facts where company_id=any($1::uuid[])',
      [companies],
    );
    await db.sonarPool.query(
      'delete from contacts where company_id=any($1::uuid[])',
      [companies],
    );
    await db.sonarPool.query(
      'delete from campaign_companies where campaign_id=$1',
      [campaignId],
    );
    await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
      companies,
    ]);
    await db.sonarPool.query('delete from campaigns where id=$1', [campaignId]);
    await db.sonarPool.query('delete from users where id=$1', [userId]);
    await admin.stop();
    await (await import('./tasks.js')).closeTaskQueue();
    await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  });
});
