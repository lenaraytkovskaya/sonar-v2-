import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let scoring: typeof import('./scoring.js');
let campaigns: typeof import('./campaigns.js');
let tasks: typeof import('./tasks.js');
let admin: import('pg-boss').PgBoss;
const data = {
  name: 'Scoring integration',
  country_code: 'UA',
  language_code: 'uk',
  cities: ['Київ'],
  queries: ['СТО'],
  offer: '',
  batch_size: 20 as const,
  budget_usd: 0.5,
  channels: { email: true, telegram: false, whatsapp: false, forms: false },
  send_mode: 'approval' as const,
  status: 'draft' as const,
  field_profile: 'contacts' as const,
  scoring_weights: { phone: 1, email: 1 },
};

async function fixture(
  run: (companyId: string, campaignId: string, userId: string) => Promise<void>,
) {
  const userId = randomUUID(),
    companyId = randomUUID();
  let campaignId: string | undefined;
  try {
    await db.sonarPool.query(
      "insert into users(id,email,name,password_hash) values($1,$2,'Score test','unusable')",
      [userId, `${userId}@example.invalid`],
    );
    const campaign = await campaigns.saveCampaign(data, null, userId);
    campaignId = String(campaign.id);
    const batch = await db.sonarPool.query(
      "insert into batches(campaign_id,number,size,config,request_key) values($1,1,20,'{}',$2) returning id",
      [campaignId, randomUUID()],
    );
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,website,status) values($1::uuid,$1::text,'Score test','https://example.com','enriching')",
      [companyId],
    );
    await db.sonarPool.query(
      'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
      [campaignId, companyId, batch.rows[0].id],
    );
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source,rank) values($1,'phone','+380671234567','+380671234567','google',50)",
      [companyId],
    );
    await run(companyId, campaignId, userId);
  } finally {
    const scoreTasks = (
      await db.sonarPool.query(
        'select id::text from tasks where subject_id=$1',
        [companyId],
      )
    ).rows.map((row) => row.id);
    await db.sonarPool.query(
      "delete from pgboss.job where name='company.score' and data->>'taskId'=any($1::text[])",
      [scoreTasks],
    );
    await db.sonarPool.query('delete from tasks where subject_id=$1', [
      companyId,
    ]);
    await db.sonarPool.query('delete from company_scores where company_id=$1', [
      companyId,
    ]);
    await db.sonarPool.query('delete from contacts where company_id=$1', [
      companyId,
    ]);
    await db.sonarPool.query(
      'delete from campaign_companies where company_id=$1',
      [companyId],
    );
    await db.sonarPool.query('delete from companies where id=$1', [companyId]);
    await db.sonarPool.query('delete from activity_log where user_id=$1', [
      userId,
    ]);
    await db.sonarPool.query('delete from batches where campaign_id=$1', [
      campaignId,
    ]);
    await db.sonarPool.query('delete from campaigns where id=$1', [campaignId]);
    await db.sonarPool.query('delete from users where id=$1', [userId]);
  }
}
const scoreTasks = async (companyId: string) =>
  (
    await db.sonarPool.query(
      "select * from tasks where type='company.score' and subject_id=$1 order by created_at,id",
      [companyId],
    )
  ).rows;
const status = async (companyId: string) =>
  (
    await db.sonarPool.query('select status from companies where id=$1', [
      companyId,
    ])
  ).rows[0].status;

describe.skipIf(!enabled)(
  'scoring persistence and queue versions (disposable DB)',
  () => {
    beforeAll(async () => {
      [db, scoring, campaigns, tasks] = await Promise.all([
        import('./index.js'),
        import('./scoring.js'),
        import('./campaigns.js'),
        import('./tasks.js'),
      ]);
      const { PgBoss } = await import('pg-boss');
      admin = new PgBoss(process.env.DATABASE_URL!);
      await admin.start();
      await admin.createQueue('company.score');
    });

    it('deduplicates unchanged snapshots, versions contact changes and upserts scores atomically with ready', async () => {
      await fixture(async (companyId, campaignId) => {
        await Promise.all([
          scoring.enqueueCompanyScores(companyId),
          scoring.enqueueCompanyScores(companyId),
        ]);
        const [first] = await scoreTasks(companyId);
        expect(await scoreTasks(companyId)).toHaveLength(1);
        expect(await status(companyId)).toBe('enriching');
        expect(
          await scoring.computeCompanyScore(companyId, campaignId, first.id),
        ).toMatchObject({ score: 50, version: first.payload.version });
        expect(await status(companyId)).toBe('ready');
        expect((await scoreTasks(companyId))[0].status).toBe('done');
        await scoring.computeCompanyScore(companyId, campaignId, first.id);
        await db.sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source,rank) values($1,'email','info@example.com','info@example.com','website',100)",
          [companyId],
        );
        await db.sonarPool.query(
          "update companies set status='enriching' where id=$1",
          [companyId],
        );
        await scoring.enqueueCompanyScores(companyId);
        const queued = await scoreTasks(companyId);
        expect(queued).toHaveLength(2);
        const next = queued.find((row) => row.status === 'queued')!;
        expect(next.payload.version).not.toBe(first.payload.version);
        expect(
          await scoring.computeCompanyScore(companyId, campaignId, next.id),
        ).toMatchObject({ score: 100, version: next.payload.version });
        const scores = (
          await db.sonarPool.query(
            'select score::float8,breakdown from company_scores where company_id=$1 and campaign_id=$2',
            [companyId, campaignId],
          )
        ).rows;
        expect(scores).toHaveLength(1);
        expect(scores[0]).toMatchObject({
          score: 100,
          breakdown: {
            version: next.payload.version,
            top: {
              email: { normalized: 'info@example.com', source: 'website' },
            },
          },
        });
        // An obsolete failed task must not block a valid score for the current data.
        await db.sonarPool.query(
          "update tasks set status='failed',reason_code='old_failure',reason_uk='Попередній збій' where id=$1",
          [first.id],
        );
        await db.sonarPool.query(
          "update companies set status='enriching' where id=$1",
          [companyId],
        );
        await scoring.enqueueCompanyScores(companyId);
        expect(await status(companyId)).toBe('ready');
        expect(await scoreTasks(companyId)).toHaveLength(2);
      });
    });

    it('queues each changed campaign weighting once and recomputes after changes and reverts', async () => {
      await fixture(async (companyId, campaignId, userId) => {
        expect(await scoring.enqueueCampaignScores(campaignId, userId)).toBe(1);
        const [first] = await scoreTasks(companyId);
        expect(
          (await scoring.computeCompanyScore(companyId, campaignId, first.id))
            ?.score,
        ).toBe(50);
        const changed = { ...data, scoring_weights: { phone: 1, email: 3 } };
        await campaigns.saveCampaign(changed, campaignId, userId);
        await campaigns.saveCampaign(changed, campaignId, userId);
        expect(await scoreTasks(companyId)).toHaveLength(2);
        expect(await scoring.enqueueCampaignScores(campaignId, userId)).toBe(0);
        const second = (await scoreTasks(companyId)).find(
          (row) => row.status === 'queued',
        )!;
        expect(
          await scoring.computeCompanyScore(companyId, campaignId, second.id),
        ).toMatchObject({ score: 25, version: second.payload.version });
        await campaigns.saveCampaign(data, campaignId, userId);
        expect(await scoreTasks(companyId)).toHaveLength(3);
        const third = (await scoreTasks(companyId)).find(
          (row) => row.status === 'queued',
        )!;
        expect(third.payload.version).not.toBe(first.payload.version);
        expect(
          (await scoring.computeCompanyScore(companyId, campaignId, third.id))
            ?.score,
        ).toBe(50);
        expect(await scoring.enqueueCampaignScores(campaignId, userId)).toBe(0);
        expect(
          (
            await db.sonarPool.query(
              'select count(*)::int as n from company_scores where company_id=$1',
              [companyId],
            )
          ).rows[0].n,
        ).toBe(1);
      });
    });

    it('waits for both active website and registry enrichment before marking a scored company ready', async () => {
      await fixture(async (companyId, campaignId) => {
        for (const [type, state] of [
          ['site.scan', 'queued'],
          ['registry.match', 'running'],
        ])
          await db.sonarPool.query(
            "insert into tasks(type,status,subject_type,subject_id,idempotency_key) values($1,$2,'company',$3,$4)",
            [type, state, companyId, randomUUID()],
          );
        await scoring.enqueueCompanyScores(companyId);
        const [task] = await scoreTasks(companyId);
        await scoring.computeCompanyScore(companyId, campaignId, task.id);
        expect(await status(companyId)).toBe('enriching');
        await db.sonarPool.query(
          "update tasks set status='done' where subject_id=$1 and type='site.scan'",
          [companyId],
        );
        await scoring.enqueueCompanyScores(companyId);
        expect(await status(companyId)).toBe('enriching');
        await db.sonarPool.query(
          "update tasks set status='done' where subject_id=$1 and type='registry.match'",
          [companyId],
        );
        await scoring.enqueueCompanyScores(companyId);
        expect(await status(companyId)).toBe('ready');
        expect(await scoreTasks(companyId)).toHaveLength(1);
      });
    });
  },
);

afterAll(async () => {
  if (enabled && db) {
    await tasks.closeTaskQueue();
    await admin?.stop();
    await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  }
});
