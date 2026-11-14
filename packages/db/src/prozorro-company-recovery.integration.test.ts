import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ProzorroCompanySnapshot } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let tasks: typeof import('./tasks.js');
let prozorro: typeof import('./prozorro.js');
let admin: import('pg-boss').PgBoss;
const companies: string[] = [],
  campaigns: string[] = [],
  users: string[] = [];
const A = '12345678',
  B = '87654321';
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  tasks = await import('./tasks.js');
  prozorro = await import('./prozorro.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    supervise: false,
    schedule: false,
  });
  await admin.start();
  await admin.createQueue('prozorro.company');
});
async function company(code = A) {
  const id = randomUUID();
  companies.push(id);
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$2,'Prozorro recovery fixture','UA')",
    [id, id],
  );
  await setCode(id, code);
  return id;
}
async function setCode(id: string, code: string) {
  const c = await db.sonarPool.connect();
  try {
    await c.query('begin');
    await c.query('select id from companies where id=$1 for update', [id]);
    await c.query(
      "delete from company_facts where company_id=$1 and kind='edrpou'",
      [id],
    );
    await c.query(
      "insert into company_facts(company_id,kind,value,source) values($1,'edrpou',$2,'registry')",
      [id, JSON.stringify(code)],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}
function snapshot(code: string, withContact = false): ProzorroCompanySnapshot {
  return {
    code,
    checkedAt: new Date().toISOString(),
    tenders: withContact
      ? [
          {
            contacts: [
              {
                kind: 'email',
                value: 'stale-a@example.test',
                sourceUrl:
                  'https://prozorro.gov.ua/tender/UA-2026-11-01-000001-a',
                date: '2026-11-01T00:00:00.000Z',
              },
            ],
          },
        ]
      : [],
  } as unknown as ProzorroCompanySnapshot;
}
async function task(id: string) {
  return (await db.sonarPool.query('select * from tasks where id=$1', [id]))
    .rows[0];
}
async function live(companyId: string) {
  return (
    await db.sonarPool.query(
      "select j.* from pgboss.job j join tasks t on j.data->>'taskId'=t.id::text where j.name='prozorro.company' and t.payload->>'companyId'=$1 and j.state in ('created','retry','active')",
      [companyId],
    )
  ).rows;
}
it.skipIf(!enabled)(
  'recovers CRM running after an actual pg-boss expiry and restart; preserves live work and retries one version',
  async () => {
    const id = await company();
    const queued = await tasks.enqueueProzorroCompany(id);
    const [job] = await admin.fetch<{ taskId: string }>('prozorro.company');
    expect(job!.data.taskId).toBe(queued.id);
    await db.sonarPool.query(
      "update tasks set status='running',started_at=now() where id=$1",
      [queued.id],
    );
    // Simulate the stopped process's aged active job, then execute pg-boss's real expiry maintenance.
    await db.sonarPool.query(
      "update pgboss.job set started_on=now()-interval '1 hour',expire_seconds=1 where name='prozorro.company' and id=$1",
      [job!.id],
    );
    await db.sonarPool.query(
      "update pgboss.queue set monitor_claim_on=now()-interval '1 day',monitor_on=now()-interval '1 day' where name='prozorro.company'",
    );
    await admin.supervise('prozorro.company');
    expect(
      (
        await db.sonarPool.query(
          "select state,retry_limit from pgboss.job where name='prozorro.company' and id=$1",
          [job!.id],
        )
      ).rows[0],
    ).toMatchObject({ state: 'failed', retry_limit: 0 });
    await admin.stop();
    const { PgBoss } = await import('pg-boss');
    admin = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      supervise: false,
      schedule: false,
    });
    await admin.start();
    await tasks.reconcileProzorroCompanyTasks();
    expect(await task(queued.id)).toMatchObject({
      status: 'failed',
      reason_code: 'prozorro_company_interrupted',
    });
    const retry = await tasks.retryTask(queued.id, null as never);
    expect(retry).toBe(true);
    const version = (await task(queued.id)).payload.version;
    await Promise.all([
      tasks.reconcileProzorroCompanyTasks(),
      tasks.enqueueProzorroCompany(id),
      tasks.enqueueProzorroCompany(id),
    ]);
    expect(await live(id)).toHaveLength(1);
    expect((await task(queued.id)).payload.version).toBe(version);
    expect((await task(queued.id)).idempotency_key).toBe(
      `prozorro.company:${id}:${new Date().toISOString().slice(0, 10)}`,
    );
  },
);
it.skipIf(!enabled)(
  'does not replace an expired job whose worker still owns the company lease',
  async () => {
    const id = await company();
    const queued = await tasks.enqueueProzorroCompany(id);
    const release = await prozorro.acquireProzorroCompanyLease(id);
    try {
      await db.sonarPool.query(
        "update tasks set status='running' where id=$1",
        [queued.id],
      );
      await db.sonarPool.query(
        "update pgboss.job set state='failed' where name='prozorro.company' and data->>'taskId'=$1",
        [queued.id],
      );
      await tasks.reconcileProzorroCompanyTasks();
      expect(await task(queued.id)).toMatchObject({ status: 'running' });
      expect((await tasks.enqueueProzorroCompany(id)).created).toBe(false);
      expect(await live(id)).toHaveLength(0);
    } finally {
      await release?.();
    }
    await tasks.reconcileProzorroCompanyTasks();
    expect((await task(queued.id)).status).toBe('failed');
  },
);
it.skipIf(!enabled)(
  'rejects fetched A after code becomes B; hides stale cache, preserves unrelated contacts and requeues the same day once',
  async () => {
    const id = await company();
    const old = {
      ...snapshot(A),
      checkedAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await prozorro.saveProzorroCompanySnapshot(id, old)).toBe(true);
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'email','kept@example.test','kept@example.test','manual')",
      [id],
    );
    const queued = await tasks.enqueueProzorroCompany(id);
    const versionA = (await task(queued.id)).payload.version;
    const [job] = await admin.fetch('prozorro.company');
    const fetchedCode = await prozorro.prozorroCompanyCode(id);
    expect(fetchedCode).toBe(A);
    await setCode(id, B);
    expect(
      await prozorro.saveProzorroCompanySnapshot(
        id,
        snapshot(fetchedCode!, true),
      ),
    ).toBe(false);
    expect(await prozorro.getProzorroCompanySnapshot(id)).toBeNull();
    expect(
      (
        await db.sonarPool.query(
          'select normalized from contacts where company_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ normalized: 'kept@example.test' }]);
    expect(
      (
        await db.sonarPool.query(
          "select value from company_facts where company_id=$1 and kind='prozorro_company'",
          [id],
        )
      ).rows[0].value,
    ).toEqual(old);
    expect((await tasks.enqueueProzorroCompany(id)).created).toBe(false);
    expect(await live(id)).toHaveLength(1);
    await admin.complete('prozorro.company', job!.id);
    await db.sonarPool.query(
      "update tasks set status='skipped',reason_code='prozorro_identity_changed' where id=$1",
      [queued.id],
    );
    await tasks.reconcileProzorroCompanyTasks();
    const corrected = await task(queued.id);
    expect(corrected.payload.code).toBe(B);
    expect(corrected.payload.version).not.toBe(versionA);
    expect(corrected.idempotency_key).toBe(
      `prozorro.company:${id}:${new Date().toISOString().slice(0, 10)}`,
    );
    expect(await live(id)).toHaveLength(1);
    await Promise.all([
      tasks.enqueueProzorroCompany(id),
      tasks.enqueueProzorroCompany(id),
    ]);
    expect(await live(id)).toHaveLength(1);
    expect(await prozorro.saveProzorroCompanySnapshot(id, snapshot(B))).toBe(
      true,
    );
    expect((await prozorro.getProzorroCompanySnapshot(id))?.code).toBe(B);
  },
);
it.skipIf(!enabled)(
  'bulk excludes only fresh snapshots for the current trusted code',
  async () => {
    const id = await company();
    await prozorro.saveProzorroCompanySnapshot(id, snapshot(A));
    const campaignId = randomUUID(),
      userId = randomUUID();
    campaigns.push(campaignId);
    users.push(userId);
    await db.sonarPool.query(
      "insert into users(id,email,name,password_hash) values($1,$2,'Fixture','unused')",
      [userId, `${userId}@example.test`],
    );
    await db.sonarPool.query(
      "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Fixture','UA','uk','{}','{}','',0,'{}','{}')",
      [campaignId],
    );
    await db.sonarPool.query(
      'insert into campaign_companies(campaign_id,company_id) values($1,$2)',
      [campaignId, id],
    );
    expect(await tasks.enqueueCampaignProzorro(campaignId, userId)).toBe(0);
    await setCode(id, B);
    expect(await tasks.enqueueCampaignProzorro(campaignId, userId)).toBe(1);
    expect(await tasks.enqueueCampaignProzorro(campaignId, userId)).toBe(0);
    expect(await live(id)).toHaveLength(1);
  },
);
it.skipIf(!enabled)(
  'runs the real tracked worker through A fetch, B correction, rejected save and one B successor',
  async () => {
    const id = await company();
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    await tasks.boss.start();
    await tasks.runTask('prozorro.company', async (raw) => {
      const payload = raw as { companyId: string; code: string };
      handled.push(payload.code);
      if (payload.code === A) {
        entered = true;
        await gate;
      }
      const saved = await prozorro.saveProzorroCompanySnapshot(
        payload.companyId,
        snapshot(payload.code, payload.code === A),
      );
      return saved
        ? { status: 'done', result: { code: payload.code } }
        : {
            status: 'skipped',
            reasonCode: 'prozorro_identity_changed',
            reasonUk: 'Код ЄДРПОУ змінився.',
          };
    });
    const queued = await tasks.enqueueProzorroCompany(id);
    try {
      await vi.waitFor(() => expect(entered).toBe(true), {
        timeout: 6000,
        interval: 50,
      });
      await setCode(id, B);
      expect((await tasks.enqueueProzorroCompany(id)).created).toBe(false);
      expect(await live(id)).toHaveLength(1);
    } finally {
      release();
    }
    await vi.waitFor(
      async () => expect((await task(queued.id)).status).toBe('skipped'),
      { timeout: 6000, interval: 50 },
    );
    await vi.waitFor(async () => expect(await live(id)).toHaveLength(0), {
      timeout: 6000,
      interval: 50,
    });
    expect(await prozorro.getProzorroCompanySnapshot(id)).toBeNull();
    await tasks.reconcileProzorroCompanyTasks();
    await vi.waitFor(
      async () => expect((await task(queued.id)).status).toBe('done'),
      { timeout: 6000, interval: 50 },
    );
    expect(handled).toEqual([A, B]);
    expect((await prozorro.getProzorroCompanySnapshot(id))?.code).toBe(B);
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int as count from contacts where company_id=$1',
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
  },
);
afterEach(async () => {
  if (!db) return;
  const ids = (
    await db.sonarPool.query(
      "select id from tasks where type='prozorro.company' and payload->>'companyId'=any($1::text[])",
      [companies],
    )
  ).rows.map((r) => r.id);
  await db.sonarPool.query(
    "delete from pgboss.job where name='prozorro.company' and data->>'taskId'=any($1::text[])",
    [ids],
  );
  await db.sonarPool.query(
    'delete from activity_log where entity_id=any($1::text[])',
    [companies],
  );
  await db.sonarPool.query('delete from tasks where id=any($1::uuid[])', [ids]);
});
afterAll(async () => {
  if (!db) return;
  await db.sonarPool.query(
    'delete from campaign_companies where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
    campaigns,
  ]);
  await db.sonarPool.query(
    'delete from contacts where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query(
    'delete from company_facts where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companies,
  ]);
  await db.sonarPool.query('delete from users where id=any($1::uuid[])', [
    users,
  ]);
  await tasks.closeTaskQueue();
  await admin.stop();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
