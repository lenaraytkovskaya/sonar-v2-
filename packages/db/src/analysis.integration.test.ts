import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let tasks: typeof import('./tasks.js');
let admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  tasks = await import('./tasks.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('company.analyze');
});
it.skipIf(!enabled)(
  'deduplicates by version, skips low scores, replays paid invalid JSON and respects campaign budget',
  async () => {
    const { enqueueCompanyAnalysis } = await import('./analysis.js');
    const { runCompanyAnalysis } =
      await import('../../../apps/worker/src/analysis.js');
    const companyId = randomUUID(),
      campaignId = randomUUID(),
      batchId = randomUUID();
    const keys = [
      'ai.models',
      'ai.model.cheap',
      'company.about',
      'budget.monthly_usd',
      'analysis.version',
      'analysis.prompt',
    ];
    const originals = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    const set = async (key: string, value: unknown) =>
      db.sonarPool.query(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
        [key, JSON.stringify(value)],
      );
    const paid = vi.fn(async () => ({
      id: 'stub',
      model: 'stub-analysis',
      text: 'invalid JSON',
      costUsd: 0.0001,
      units: 10,
    }));
    const api = { complete: paid, models: vi.fn() };
    try {
      await set('ai.models', [
        {
          id: 'stub-analysis',
          promptUsd: 0,
          completionUsd: 0,
          requestUsd: 0.0001,
        },
      ]);
      await set('ai.model.cheap', 'stub-analysis');
      await set('company.about', '');
      await set('budget.monthly_usd', 1000000);
      await set('analysis.version', 'test-1');
      await db.sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Analysis test','PL','pl','{}','{}','offer exists',1,'{}','{}')",
        [campaignId],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [batchId, campaignId, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name) values($1::uuid,$1::text,'Analysis test')",
        [companyId],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [campaignId, companyId, batchId],
      );
      await db.sonarPool.query(
        "insert into company_scores(company_id,campaign_id,score,breakdown) values($1,$2,39,'{}')",
        [companyId, campaignId],
      );
      const first = (await enqueueCompanyAnalysis(
        companyId,
        campaignId,
        null,
      ))!;
      expect(
        (await enqueueCompanyAnalysis(companyId, campaignId, null))?.id,
      ).toBe(first.id);
      const originalPrompt = (
        await db.sonarPool.query(
          "select value from settings where key='analysis.prompt'",
        )
      ).rows[0].value;
      await set('analysis.prompt', 'A changed prompt for the next version');
      const input = { companyId, campaignId, version: 'test-1' };
      expect(await runCompanyAnalysis(input, first.id, api)).toMatchObject({
        status: 'skipped',
      });
      expect(paid).not.toHaveBeenCalled();
      expect(
        (
          await db.sonarPool.query('select result from tasks where id=$1', [
            first.id,
          ])
        ).rows[0].result.analysisInput.config['analysis.prompt'],
      ).toBe(originalPrompt);
      await db.sonarPool.query(
        "update tasks set status='skipped',reason_code='score_below_threshold' where id=$1",
        [first.id],
      );
      await db.sonarPool.query(
        "update companies set website='https://example.invalid' where id=$1",
        [companyId],
      );
      await db.sonarPool.query(
        'update campaigns set scoring_weights=\'{"website":1}\' where id=$1',
        [campaignId],
      );
      await db.sonarPool.query(
        "insert into company_facts(company_id,kind,value,source) values($1,'site_status','{\"status\":\"done\"}','website')",
        [companyId],
      );
      const { computeCompanyScore } = await import('./scoring.js');
      await computeCompanyScore(companyId, campaignId, randomUUID());
      expect(
        (
          await db.sonarPool.query('select status from tasks where id=$1', [
            first.id,
          ])
        ).rows[0].status,
      ).toBe('queued');
      const recovered = await Promise.all([
        enqueueCompanyAnalysis(companyId, campaignId, null),
        enqueueCompanyAnalysis(companyId, campaignId, null),
      ]);
      expect(recovered.map((t) => t?.id)).toEqual([first.id, first.id]);
      expect(recovered.filter((t) => t?.created)).toHaveLength(0);
      expect(recovered.every((t) => t?.status === 'queued')).toBe(true);
      await expect(
        runCompanyAnalysis(input, first.id, api),
      ).rejects.toMatchObject({ code: 'analysis_schema_invalid' });
      await expect(
        runCompanyAnalysis(input, first.id, api),
      ).rejects.toMatchObject({ code: 'analysis_schema_invalid' });
      expect(paid).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.sonarPool.query(
            'select * from spend_events where task_id=$1',
            [first.id],
          )
        ).rows,
      ).toHaveLength(1);
      await set('analysis.version', 'test-2');
      const next = (await enqueueCompanyAnalysis(companyId, campaignId, null))!;
      expect(next.id).not.toBe(first.id);
      paid.mockResolvedValue({
        id: 'stub',
        model: 'stub-analysis',
        text: JSON.stringify({
          summary: 'Польська компанія.',
          language: 'pl',
          best_channel: null,
          first_message: 'Must be cleared',
          fit: 60,
          fit_reason: 'Відповідає кампанії.',
        }),
        costUsd: 0.0001,
        units: 10,
      });
      const nextInput = { ...input, version: 'test-2' };
      expect(await runCompanyAnalysis(nextInput, next.id, api)).toMatchObject({
        status: 'done',
        result: { language: 'pl', first_message: '' },
      });
      await runCompanyAnalysis(nextInput, next.id, api);
      expect(paid).toHaveBeenCalledTimes(2);
      expect(
        (
          await db.sonarPool.query(
            'select * from analyses where company_id=$1',
            [companyId],
          )
        ).rows,
      ).toHaveLength(1);
      await set('analysis.version', 'test-3');
      const blocked = (await enqueueCompanyAnalysis(
        companyId,
        campaignId,
        null,
      ))!;
      await db.sonarPool.query(
        'update campaigns set budget_usd=0 where id=$1',
        [campaignId],
      );
      expect(
        await runCompanyAnalysis(
          { ...input, version: 'test-3' },
          blocked.id,
          api,
        ),
      ).toMatchObject({ status: 'paused', reasonCode: 'budget_exceeded' });
      expect(paid).toHaveBeenCalledTimes(2);
    } finally {
      const ids = (
        await db.sonarPool.query(
          'select id::text from tasks where subject_id=$1',
          [companyId],
        )
      ).rows.map((row) => row.id);
      await db.sonarPool.query(
        "delete from pgboss.job where name='company.analyze' and data->>'taskId'=any($1::text[])",
        [ids],
      );
      await db.sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [ids],
      );
      await db.sonarPool.query('delete from tasks where subject_id=$1', [
        companyId,
      ]);
      await db.sonarPool.query(
        'delete from company_scores where company_id=$1',
        [companyId],
      );
      await db.sonarPool.query('delete from analyses where company_id=$1', [
        companyId,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [companyId],
      );
      await db.sonarPool.query(
        'delete from company_facts where company_id=$1',
        [companyId],
      );
      await db.sonarPool.query('delete from companies where id=$1', [
        companyId,
      ]);
      await db.sonarPool.query(
        "delete from activity_log where entity_type='company' and entity_id=$1",
        [companyId],
      );
      await db.sonarPool.query('delete from batches where id=$1', [batchId]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        campaignId,
      ]);
      await db.sonarPool.query(
        'delete from settings where key=any($1::text[])',
        [keys],
      );
      for (const row of originals) await set(row.key, row.value);
    }
  },
);
afterAll(async () => {
  if (enabled && db) {
    await tasks.closeTaskQueue();
    await admin.stop();
    await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  }
});
