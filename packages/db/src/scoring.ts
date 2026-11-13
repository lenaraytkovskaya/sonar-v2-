import { enqueueCompanyAnalysis } from './analysis.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { scoreCompany, registryTerminated, platformKind } from '@sonar/core';
import { sonarPool } from './index.js';
import { enqueueTask, logActivity } from './tasks.js';

// One statement captures a consistent, ordered snapshot for both scoring and its key.
async function snapshot(
  client: Pick<PoolClient, 'query'>,
  companyId: string,
  campaignId: string,
) {
  const {
    rows: [row],
  } = await client.query(
    `select c.website,(select value from settings where key='platforms.kinds') as platform_kinds,c.rating,c.ratings_count,a.scoring_weights,a.scoring_revision,a.min_score,
      coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from contacts p where p.company_id=c.id),'[]') as contacts,
      coalesce((select jsonb_agg(to_jsonb(f) order by f.found_at desc,f.id) from company_facts f where f.company_id=c.id and (f.expires_at is null or f.expires_at>now()) and f.kind in ('site_status','registry_entity','registry_status','termination_date')),'[]') as facts
     from companies c join campaign_companies cc on cc.company_id=c.id join campaigns a on a.id=cc.campaign_id
     where c.id=$1 and a.id=$2`,
    [companyId, campaignId],
  );
  if (!row) return null;
  const version = createHash('sha256')
    .update(JSON.stringify(row))
    .digest('hex');
  const fact = (kind: string, source: string) =>
    row.facts.find(
      (f: { kind: string; source: string }) =>
        f.kind === kind && f.source === source,
    )?.value;
  return {
    version,
    weights: row.scoring_weights,
    input: {
      website: row.website,
      isPlatform:
        !!row.website &&
        !!platformKind(new URL(row.website).hostname, row.platform_kinds ?? {}),
      siteScanDone: fact('site_status', 'website')?.status === 'done',
      rating: row.rating === null ? null : Number(row.rating),
      ratingsCount: row.ratings_count,
      registryFound: !!fact('registry_entity', 'registry'),
      registryTerminated:
        !!fact('termination_date', 'registry') ||
        registryTerminated(fact('registry_status', 'registry') ?? null),
      contacts: row.contacts,
    },
  };
}

async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  existing?: PoolClient,
) {
  if (existing) return fn(existing);
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueScore(
  client: PoolClient,
  companyId: string,
  campaignId: string,
) {
  const data = await snapshot(client, companyId, campaignId);
  if (!data) return false;
  const id = await enqueueTask(
    'company.score',
    `company.score:${companyId}:${campaignId}:${data.version}`,
    { companyId, campaignId, version: data.version },
    client,
  );
  if (id)
    await client.query(
      "update tasks set subject_type='company',subject_id=$2 where id=$1",
      [id, companyId],
    );
  return !!id;
}

export async function enqueueCampaignScores(
  campaignId: string,
  userId: string | null,
  existing?: PoolClient,
) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'select company_id from campaign_companies where campaign_id=$1 order by company_id',
      [campaignId],
    );
    let count = 0;
    for (const row of rows)
      if (await enqueueScore(client, row.company_id, campaignId)) count++;
    await logActivity(
      'campaign.score',
      'campaign',
      campaignId,
      userId,
      { count },
      client,
    );
    return count;
  }, existing);
}

export async function enqueueCompanyScores(companyId: string) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'select campaign_id from campaign_companies where company_id=$1 order by campaign_id',
      [companyId],
    );
    for (const row of rows)
      await enqueueScore(client, companyId, row.campaign_id);
    // Completed, unchanged snapshots also allow a repeated enrichment to finish.
    await markReady(client, companyId);
  });
}

async function markReady(client: PoolClient, companyId: string) {
  const { rows: pending } = await client.query(
    "select 1 from tasks where subject_id=$1 and type in ('site.scan','registry.match') and status in ('queued','running') limit 1",
    [companyId],
  );
  if (pending.length) return;
  const { rows } = await client.query(
    'select cc.campaign_id,s.breakdown from campaign_companies cc left join company_scores s on s.company_id=cc.company_id and s.campaign_id=cc.campaign_id where cc.company_id=$1',
    [companyId],
  );
  for (const row of rows) {
    const data = await snapshot(client, companyId, row.campaign_id);
    if (!data || row.breakdown?.version !== data.version) return;
  }
  await client.query(
    "update companies set status='ready',updated_at=now() where id=$1 and status='enriching'",
    [companyId],
  );
}

export async function computeCompanyScore(
  companyId: string,
  campaignId: string,
  taskId: string,
) {
  return transaction(async (client) => {
    // Serialize saves against campaign weight edits and other scores for this company.
    await client.query('select id from campaigns where id=$1 for share', [
      campaignId,
    ]);
    await client.query('select id from companies where id=$1 for update', [
      companyId,
    ]);
    const data = await snapshot(client, companyId, campaignId);
    if (!data) return null;
    const result = scoreCompany(data.input, data.weights);
    await client.query(
      `insert into company_scores(company_id,campaign_id,score,breakdown) values($1,$2,$3,$4)
      on conflict(company_id,campaign_id) do update set score=excluded.score,breakdown=excluded.breakdown,computed_at=now()`,
      [
        companyId,
        campaignId,
        result.score,
        { ...result.breakdown, version: data.version },
      ],
    );
    // Persist completion with the score and ready transition atomically. A retry reads fresh data.
    await client.query(
      "update tasks set status='done',finished_at=now(),result=$2 where id=$1",
      [taskId, { score: result.score, version: data.version }],
    );
    await markReady(client, companyId);
    const {
      rows: [threshold],
    } = await client.query(
      'select min_score as value from campaigns where id=$1',
      [campaignId],
    );
    if (result.score >= Number(threshold?.value))
      await enqueueCompanyAnalysis(companyId, campaignId, null, client);
    return { score: result.score, version: data.version };
  });
}
