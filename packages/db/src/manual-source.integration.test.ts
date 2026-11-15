import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ManualSourceInput } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let save: typeof import('./manual-source.js').saveManualSource;
let admin: import('pg-boss').PgBoss;
let userId: string;
let campaignId: string;
const companies: string[] = [];
const request = (
  source: ManualSourceInput['source'],
  value: string,
  expected: string | null = null,
): ManualSourceInput => ({ requestId: randomUUID(), source, value, expected });
async function company() {
  const {
    rows: [row],
  } = await db.sonarPool.query(
    "insert into companies(place_id,name,country_code) values($1,'Manual source synthetic','UA') returning id",
    [`manual:${randomUUID()}`],
  );
  companies.push(row.id);
  await db.sonarPool.query(
    'insert into campaign_companies(company_id,campaign_id) values($1,$2)',
    [row.id, campaignId],
  );
  return row.id as string;
}
describe.skipIf(!enabled)('manual source transactions', () => {
  beforeAll(async () => {
    db = await import('./index.js');
    save = (await import('./manual-source.js')).saveManualSource;
    const { PgBoss } = await import('pg-boss');
    admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    for (const type of [
      'site.scan',
      'registry.match',
      'google.company',
      'social.fetch',
    ])
      await admin.createQueue(type);
    userId = (
      await db.sonarPool.query(
        "insert into users(email,name,password_hash) values($1,'Synthetic source user','unused') returning id",
        [`${randomUUID()}@example.test`],
      )
    ).rows[0].id;
    campaignId = (
      await db.sonarPool.query(
        "insert into campaigns(name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values('Manual source synthetic','UA','uk','{}','{}','',1,'{}','{}') returning id",
      )
    ).rows[0].id;
  });
  it('deduplicates concurrent submits and preserves provenance, actor, date and exact queued website', async () => {
    const id = await company(),
      data = request('website', 'example.com');
    const [first, second] = await Promise.all([
      save(id, data, userId),
      save(id, data, userId),
    ]);
    expect(first?.tasks[0].id).toBe(second?.tasks[0].id);
    expect(first).toMatchObject({
      target: 'https://example.com/',
      foundAt: expect.any(Date),
    });
    const tasks = (
      await db.sonarPool.query(
        'select payload from tasks where subject_id=$1',
        [id],
      )
    ).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload).toMatchObject({
      companyId: id,
      website: 'https://example.com/',
    });
    expect(
      (
        await db.sonarPool.query(
          "select user_id,details from activity_log where entity_id=$1 and action='company.source.manual'",
          [id],
        )
      ).rows,
    ).toMatchObject([{ user_id: userId, details: { previous: null } }]);
  });
  it('rejects unreviewed/stale replacement and active tasks for a different website; preserves history', async () => {
    const id = await company();
    const first = await save(id, request('website', 'example.com'), userId);
    await expect(
      save(id, request('website', 'example.org'), userId),
    ).rejects.toThrow('staleSource');
    await expect(
      save(
        id,
        request('website', 'example.org', 'https://example.com/'),
        userId,
      ),
    ).rejects.toThrow('sourceBusy');
    await db.sonarPool.query("update tasks set status='done' where id=$1", [
      first!.tasks[0].id,
    ]);
    const next = await save(
      id,
      request('website', 'example.org', 'https://example.com/'),
      userId,
    );
    expect(next).toMatchObject({
      target: 'https://example.org/',
      previous: 'https://example.com/',
    });
    expect(
      (
        await db.sonarPool.query(
          "select id from company_facts where company_id=$1 and kind='manual_source'",
          [id],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('rejects request ID reuse for a different target and a missing company', async () => {
    const id = await company(),
      data = request('website', 'example.com');
    await save(id, data, userId);
    await expect(
      save(id, { ...data, value: 'example.org' }, userId),
    ).rejects.toThrow('staleSource');
    await expect(save(randomUUID(), data, userId)).rejects.toThrow(
      'companyNotFound',
    );
  });
  it('rolls back the source and website if queue dispatch fails', async () => {
    const id = await company();
    await db.sonarPool.query(
      "update settings set key='test.tasks.site.scan' where key='tasks.site.scan'",
    );
    try {
      await expect(
        save(id, request('website', 'example.com'), userId),
      ).rejects.toThrow('Missing task settings');
    } finally {
      await db.sonarPool.query(
        "update settings set key='tasks.site.scan' where key='test.tasks.site.scan'",
      );
    }
    expect(
      (
        await db.sonarPool.query('select website from companies where id=$1', [
          id,
        ])
      ).rows[0].website,
    ).toBeNull();
    expect(
      (
        await db.sonarPool.query(
          'select id from company_facts where company_id=$1',
          [id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('queues only the new social target via the existing shared collection/session machinery', async () => {
    const id = await company();
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'social','https://www.facebook.com/other.source/','https://www.facebook.com/other.source/','manual')",
      [id],
    );
    const data = {
      ...request('social', '@sonar_synthetic_source'),
      network: 'instagram' as const,
    };
    const first = await save(id, data, userId);
    const again = await save(id, { ...data, requestId: randomUUID() }, userId);
    expect(first?.tasks[0].id).toBe(again?.tasks[0].id);
    const task = (
      await db.sonarPool.query('select payload from tasks where id=$1', [
        first!.tasks[0].id,
      ])
    ).rows[0];
    expect(task.payload).toMatchObject({
      companyId: id,
      target: {
        network: 'instagram',
        canonicalUrl: 'https://www.instagram.com/sonar_synthetic_source/',
      },
      manual: true,
    });
    expect(
      (
        await db.sonarPool.query(
          "select id from contacts where company_id=$1 and kind='social'",
          [id],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('saves a manual code without marking it verified and queues the exact registry code', async () => {
    const id = await company(),
      data = request('registry', '00123456');
    const [a, b] = await Promise.all([
      save(id, data, userId),
      save(id, data, userId),
    ]);
    expect(a?.tasks[0].id).toBe(b?.tasks[0].id);
    expect(
      (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          a!.tasks[0].id,
        ])
      ).rows[0].payload,
    ).toMatchObject({ companyId: id, manualCode: '00123456' });
    expect(
      (
        await db.sonarPool.query(
          "select kind,source,value from company_facts where company_id=$1 and kind='edrpou'",
          [id],
        )
      ).rows,
    ).toEqual([{ kind: 'edrpou', source: 'manual', value: '00123456' }]);
    await expect(
      save(id, request('registry', '00123457'), userId),
    ).rejects.toThrow('conflictingCode');
  });
  it('shares PR95 code serialization and refuses a different verified registry code', async () => {
    const id = await company();
    await db.sonarPool.query(
      "insert into company_facts(company_id,kind,value,source) values($1,'edrpou','\"00123456\"','registry')",
      [id],
    );
    await expect(
      save(id, request('registry', '00123457'), userId),
    ).rejects.toThrow('conflictingCode');
    const lock = await db.sonarPool.connect();
    try {
      await lock.query(
        "select pg_advisory_lock(hashtextextended('prozorro.company:'||$1,0))",
        [id],
      );
      await expect(
        save(id, request('registry', '00123456'), userId),
      ).rejects.toThrow('sourceBusy');
    } finally {
      await lock.query('select pg_advisory_unlock_all()');
      lock.release();
    }
  });
  it('binds Google to campaign budget and explicit source while preserving CRM place ID and name', async () => {
    const id = await company();
    const old = (
      await db.sonarPool.query(
        'select name,place_id from companies where id=$1',
        [id],
      )
    ).rows[0];
    const maps =
      'https://maps.google.com/?q=place_id:ChIJj61dQgK6j4AR4GeTYWZsKWw';
    const result = await save(id, request('googleMaps', maps), userId);
    expect(
      (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          result!.tasks[0].id,
        ])
      ).rows[0].payload,
    ).toMatchObject({
      companyId: id,
      campaignId,
      placeId: 'ChIJj61dQgK6j4AR4GeTYWZsKWw',
      sourceUrl: result!.target,
    });
    expect(
      (
        await db.sonarPool.query(
          'select name,place_id from companies where id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual(old);
  });
  it('accounts a mocked Google request once and saves only its matching source snapshot', async () => {
    const id = await company();
    const result = await save(
      id,
      request(
        'googleMaps',
        'https://maps.google.com/?q=place_id:ChIJj61dQgK6j4AR4GeTYWZsKWw',
      ),
      userId,
    );
    const taskId = result!.tasks[0].id;
    const payload = (
      await db.sonarPool.query('select payload from tasks where id=$1', [
        taskId,
      ])
    ).rows[0].payload;
    const { runGoogleCompany } =
      await import('../../../apps/worker/src/google-company.js');
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Response.json({
        id: payload.placeId,
        displayName: { text: 'Mocked Google company' },
        websiteUri: 'https://example.com/',
      });
    };
    expect(await runGoogleCompany(payload, taskId, fetcher)).toMatchObject({
      status: 'done',
    });
    expect(await runGoogleCompany(payload, taskId, fetcher)).toMatchObject({
      status: 'done',
    });
    expect(calls).toBe(1);
    expect(
      (
        await db.sonarPool.query(
          'select cost_usd,service_code from spend_events where task_id=$1',
          [taskId],
        )
      ).rows,
    ).toMatchObject([
      { cost_usd: '0.0200000000', service_code: 'google_places' },
    ]);
    expect(
      (
        await db.sonarPool.query(
          "select source_url from company_facts where company_id=$1 and kind='google_place'",
          [id],
        )
      ).rows,
    ).toEqual([{ source_url: result!.target }]);
    expect(
      (
        await db.sonarPool.query(
          'select website,name from companies where id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual({ website: null, name: 'Manual source synthetic' });
  });
  it('accounts but discards a Google response after a concurrent source replacement', async () => {
    const id = await company();
    const result = await save(
      id,
      request(
        'googleMaps',
        'https://maps.google.com/?q=place_id:ChIJj61dQgK6j4AR4GeTYWZsKWw',
      ),
      userId,
    );
    const taskId = result!.tasks[0].id;
    const payload = (
      await db.sonarPool.query('select payload from tasks where id=$1', [
        taskId,
      ])
    ).rows[0].payload;
    const { runGoogleCompany } =
      await import('../../../apps/worker/src/google-company.js');
    const fetcher = async () => {
      await db.sonarPool.query(
        "update companies set google_maps_uri='https://maps.google.com/?q=changed' where id=$1",
        [id],
      );
      return Response.json({ id: payload.placeId });
    };
    expect(await runGoogleCompany(payload, taskId, fetcher)).toMatchObject({
      status: 'skipped',
      reasonCode: 'source_changed',
    });
    expect(
      (
        await db.sonarPool.query(
          "select id from company_facts where company_id=$1 and kind='google_place'",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.sonarPool.query(
          'select id from spend_events where task_id=$1',
          [taskId],
        )
      ).rowCount,
    ).toBe(1);
  });
  afterAll(async () => {
    if (!db) return;
    await db.sonarPool.query(
      "delete from pgboss.job where data->>'taskId' in (select id::text from tasks where subject_id=any($1::text[]))",
      [companies],
    );
    await db.sonarPool.query(
      'delete from spend_events where task_id in (select id from tasks where subject_id=any($1::text[]))',
      [companies],
    );
    await db.sonarPool.query(
      'delete from tasks where subject_id=any($1::text[])',
      [companies],
    );
    await db.sonarPool.query(
      'delete from activity_log where entity_id=any($1::text[])',
      [companies],
    );
    await db.sonarPool.query(
      'delete from contacts where company_id=any($1::uuid[])',
      [companies],
    );
    await db.sonarPool.query(
      'delete from company_facts where company_id=any($1::uuid[])',
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
