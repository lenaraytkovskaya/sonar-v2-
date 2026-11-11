import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';

export async function enqueueCompanyAnalysis(
  companyId: string,
  campaignId: string,
  userId: string | null,
  existing?: PoolClient,
) {
  const { enqueueTask, logActivity } = await import('./tasks.js');
  const client = existing ?? (await sonarPool.connect());
  try {
    if (!existing) await client.query('begin');
    const { rows: settings } = await client.query(
      "select key,value from settings where key in ('analysis.version','analysis.prompt')",
    );
    const config = Object.fromEntries(
      settings.map((row) => [row.key, row.value]),
    );
    if (
      typeof config['analysis.version'] !== 'string' ||
      !config['analysis.version'].trim()
    )
      throw new Error('Missing analysis version');
    const {
      rows: [company],
    } = await client.query(
      'select 1 from campaign_companies where company_id=$1 and campaign_id=$2',
      [companyId, campaignId],
    );
    if (!company) {
      if (!existing) await client.query('commit');
      return null;
    }
    const version = config['analysis.version'];
    const key = `company.analyze:${companyId}:${campaignId}:${version}`;
    const id = await enqueueTask(
      'company.analyze',
      key,
      {
        companyId,
        campaignId,
        version,
        analysisPrompt: config['analysis.prompt'],
      },
      client,
    );
    if (id) {
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [id, companyId],
      );
      await logActivity(
        'company.analyze.queued',
        'company',
        companyId,
        userId,
        { taskId: id, campaignId },
        client,
      );
    }
    const {
      rows: [task],
    } = await client.query(
      'select id,status from tasks where idempotency_key=$1',
      [key],
    );
    if (!existing) await client.query('commit');
    return { id: String(task.id), status: String(task.status), created: !!id };
  } catch (error) {
    if (!existing) await client.query('rollback');
    throw error;
  } finally {
    if (!existing) client.release();
  }
}

// Freeze the data before billing so retries validate the same paid response.
export async function analysisSnapshot(
  companyId: string,
  campaignId: string,
  taskId: string,
) {
  const {
    rows: [task],
  } = await sonarPool.query(
    'select payload,result, exists(select 1 from spend_events where task_id=tasks.id) as billed from tasks where id=$1',
    [taskId],
  );
  if (
    task?.result?.analysisInput &&
    (task.billed || task.result.billingPending)
  )
    return task.result.analysisInput;
  const {
    rows: [input],
  } = await sonarPool.query(
    `select c.name,c.website,c.country_code,c.primary_type,c.address,c.rating,c.ratings_count,
    a.offer,a.language_code, s.score::float8,
    coalesce((select jsonb_agg(jsonb_build_object('kind',p.kind,'value',p.value,'source',p.source,'source_url',p.source_url,'found_at',p.found_at) order by p.rank desc,p.id) from contacts p where p.company_id=c.id),'[]') as contacts,
    coalesce((select jsonb_agg(jsonb_build_object('kind',f.kind,'value',f.value,'source',f.source,'source_url',f.source_url,'found_at',f.found_at) order by f.kind,f.source_url,f.id) from company_facts f where f.company_id=c.id and (f.expires_at is null or f.expires_at>now()) and f.kind in ('language','schema_org','registry_entity','registry_status','google_display_name')),'[]') as facts,
    coalesce((select jsonb_agg(p) from (select source_url,value from company_facts where company_id=c.id and kind='page_text' and expires_at>now() order by source_url limit 3) p),'[]') as pages
    from companies c join campaign_companies cc on cc.company_id=c.id join campaigns a on a.id=cc.campaign_id
    left join company_scores s on s.company_id=c.id and s.campaign_id=a.id where c.id=$1 and a.id=$2`,
    [companyId, campaignId],
  );
  if (!input) return null;
  const pageLimit = Math.floor(4000 / Math.max(1, input.pages.length));
  input.pages = input.pages.map((p: { source_url: string; value: unknown }) => {
    const text = String(p.value).slice(0, pageLimit);
    return { url: p.source_url, text };
  });
  const { rows } = await sonarPool.query(
    "select key,value from settings where key like 'analysis.%' or key in ('company.about','ai.models','ai.model.cheap')",
  );
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (typeof task?.payload?.analysisPrompt === 'string')
    config['analysis.prompt'] = task.payload.analysisPrompt;
  const snapshot = {
    ...input,
    about:
      typeof config['company.about'] === 'string'
        ? config['company.about'].trim()
        : '',
    config,
  };
  await sonarPool.query(
    "update tasks set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('analysisInput',$2::jsonb) where id=$1",
    [taskId, JSON.stringify(snapshot)],
  );
  return snapshot;
}
