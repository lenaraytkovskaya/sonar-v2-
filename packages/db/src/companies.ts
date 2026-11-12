import {
  companyFiltersSchema,
  normalizeWebsite,
  type CompanyFilters,
  type ScoreBreakdown,
  type AnalysisResult,
} from '@sonar/core';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';
import { transaction } from './email.js';
import { enqueueSiteScan, logActivity } from './tasks.js';

const platformSql = `exists(select 1 from jsonb_array_elements_text(coalesce((select value from settings where key='platforms.domains'),'[]'::jsonb)) x where c.domain=x or c.domain like '%.'||x)`;
export function companyWhere(input: CompanyFilters) {
  const f = companyFiltersSchema.parse(input),
    values: unknown[] = [],
    conditions: string[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const campaignParam = f.campaignId ? param(f.campaignId) : null;
  const scoreSql = `(select max(s.score)::float8 from company_scores s where s.company_id=c.id${campaignParam ? ` and s.campaign_id=${campaignParam}` : ''})`;
  if (campaignParam)
    conditions.push(
      `exists(select 1 from campaign_companies cc where cc.company_id=c.id and cc.campaign_id=${campaignParam})`,
    );
  if (f.city) conditions.push(`lower(c.city)=lower(${param(f.city)})`);
  if (f.status) conditions.push(`c.status=${param(f.status)}`);
  if (f.hasWebsite !== undefined)
    conditions.push(`(c.website is not null)=${param(f.hasWebsite)}`);
  if (f.platforms && f.platforms !== 'all')
    conditions.push(`${f.platforms === 'exclude' ? 'not ' : ''}${platformSql}`);
  if (f.hasPhone !== undefined)
    conditions.push(
      `exists(select 1 from contacts p where p.company_id=c.id and p.kind='phone')=${param(f.hasPhone)}`,
    );
  if (f.minRating !== undefined)
    conditions.push(`c.rating>=${param(f.minRating)}`);
  if (f.minScore !== undefined)
    conditions.push(`${scoreSql}>=${param(f.minScore)}`);
  if (f.q) {
    const p = param('%' + f.q.replace(/[\\%_]/g, '\\$&') + '%');
    const digits = f.q.replace(/\D/g, '');
    let phone = '';
    if (digits.length >= 3)
      phone = ` or (p.kind='phone' and regexp_replace(p.normalized,'[^0-9]','','g') like ${param('%' + digits + '%')})`;
    conditions.push(
      `(c.name ilike ${p} or c.domain ilike ${p} or exists(select 1 from contacts p where p.company_id=c.id and (p.normalized ilike ${p}${phone})))`,
    );
  }
  return {
    sql: conditions.length ? 'where ' + conditions.join(' and ') : '',
    values,
    scoreSql,
  };
}
export type CompanyRow = {
  id: string;
  name: string;
  city: string | null;
  primary_type: string | null;
  rating: string | null;
  score: number | null;
  website: string | null;
  domain: string | null;
  status: string;
  created_at: string;
  ratings_count: number | null;
  phones: string[];
  emails: string[];
  channels: string[];
  registry: boolean;
  platform: boolean;
  chain_key: string;
  chain_rank: number;
  chain_size: number;
  branches?: { id: string; name: string; address: string | null }[];
  campaigns: { id: string; name: string }[];
};
export type CompanyScoreRow = {
  campaign_id: string;
  campaign_name: string;
  score: number;
  breakdown: ScoreBreakdown;
  computed_at: Date;
};
export type CompanyAnalysisRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  version: string;
  model: string;
  cost_usd: string;
  result: AnalysisResult;
  created_at: Date;
};
export async function listCompanies(
  filters: CompanyFilters,
  page = 1,
  pageSize = 25,
  connection: Pick<PoolClient, 'query'> = sonarPool,
  { groupChains = false }: { groupChains?: boolean } = {},
) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000
  )
    throw Error('Invalid pagination');
  const parsedFilters = companyFiltersSchema.parse(filters);
  const { sql, values, scoreSql } = companyWhere(parsedFilters);
  const sort =
    parsedFilters.sort ?? (parsedFilters.campaignId ? 'score' : 'newest');
  const order = `${sort === 'score' ? 't.score desc nulls last,' : ''}t.created_at desc,t.id`;
  const windowOrder = `${sort === 'score' ? scoreSql + ' desc nulls last,' : ''}c.created_at desc,c.id`;
  // Branches of one chain share the company's own domain; listings on platforms never group.
  const platform = platformSql;
  const chainKey = groupChains
    ? `case when c.domain is null or ${platform} then c.id::text else c.domain end`
    : 'c.id::text';
  const {
    rows: [count],
  } = await connection.query(
    `select count(distinct ${chainKey})::int as total from companies c ${sql}`,
    values,
  );
  const { rows } = await connection.query<CompanyRow>(
    `select t.* from (select c.id,c.name,c.city,c.primary_type,c.rating,c.ratings_count,${scoreSql} as score,c.website,c.domain,c.status,c.created_at,
 ${platform} as platform,${chainKey} as chain_key,
 row_number() over (partition by ${chainKey} order by ${windowOrder}) as chain_rank,
 count(*) over (partition by ${chainKey})::int as chain_size,
 array(select p.normalized from contacts p where p.company_id=c.id and p.kind='phone' order by p.rank desc,p.normalized ${groupChains ? 'limit 3' : ''}) as phones,
 array(select p.normalized from contacts p where p.company_id=c.id and p.kind='email' order by (split_part(p.normalized,'@',1) ~ '^(info|office|sto|service|servis|contact|kontakt|hello|mail|sales|zakaz|order|support|admin)') desc,p.rank desc,p.normalized limit 2) as emails,
 array(select distinct p.kind from contacts p where p.company_id=c.id) as channels,
 exists(select 1 from company_facts r where r.company_id=c.id and r.kind='registry_entity') as registry,
 coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name) from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=c.id),'[]') as campaigns
 from companies c ${sql}) t where t.chain_rank=1 order by ${order.replace(/c\./g, 't.')} limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, pageSize, (page - 1) * pageSize],
  );
  const chains = rows.filter((row) => row.chain_size > 1);
  if (chains.length) {
    const { rows: branches } = await connection.query<{
      chain_key: string;
      id: string;
      name: string;
      address: string | null;
    }>(
      `select c.domain as chain_key,c.id,c.name,c.address from companies c ${sql ? sql + ' and' : 'where'} c.domain=any($${values.length + 1}) order by c.name`,
      [...values, chains.map((row) => row.chain_key)],
    );
    for (const row of chains)
      row.branches = branches
        .filter((branch) => branch.chain_key === row.chain_key)
        .map(({ id, name, address }) => ({ id, name, address }));
  }
  return { companies: rows, total: count.total as number, page, pageSize };
}
export async function getCompany(id: string) {
  const {
    rows: [company],
  } = await sonarPool.query('select * from companies where id=$1', [id]);
  if (!company) return null;
  const [
    { rows: contacts },
    { rows: campaigns },
    { rows: history },
    { rows: facts },
    { rows: scans },
    { rows: scores },
    { rows: analyses },
  ] = await Promise.all([
    sonarPool.query(
      'select * from contacts where company_id=$1 order by rank desc,found_at desc',
      [id],
    ),
    sonarPool.query(
      'select c.id,c.name,b.id as batch_id,b.number,b.status,cc.added_at from campaign_companies cc join campaigns c on c.id=cc.campaign_id left join batches b on b.id=cc.batch_id where cc.company_id=$1 order by cc.added_at desc',
      [id],
    ),
    sonarPool.query(
      "select a.id,a.action,a.created_at,a.details,u.name as user_name from activity_log a left join users u on u.id=a.user_id where a.entity_type='company' and a.entity_id=$1 order by a.created_at desc",
      [id],
    ),
    sonarPool.query(
      'select * from company_facts where company_id=$1 order by found_at desc',
      [id],
    ),
    sonarPool.query(
      "select id,status,reason_uk,result,created_at from tasks where type='site.scan' and subject_type='company' and subject_id=$1 order by created_at desc limit 20",
      [id],
    ),
    sonarPool.query<CompanyScoreRow>(
      'select s.campaign_id,c.name as campaign_name,s.score::float8 as score,s.breakdown,s.computed_at from company_scores s join campaigns c on c.id=s.campaign_id where s.company_id=$1 order by s.score desc,s.campaign_id',
      [id],
    ),
    sonarPool.query<CompanyAnalysisRow>(
      'select distinct on (a.campaign_id) a.*,c.name as campaign_name from analyses a join campaigns c on c.id=a.campaign_id where a.company_id=$1 order by a.campaign_id,a.created_at desc,a.id desc',
      [id],
    ),
  ]);
  return {
    company,
    contacts,
    campaigns,
    history,
    facts,
    scans,
    scores,
    analyses,
  };
}

// One snapshot keeps CSV pagination stable while discovery adds companies.
export async function* exportCompanies(filters: CompanyFilters) {
  const client = await sonarPool.connect();
  let committed = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    for (let page = 1; ; page++) {
      const result = await listCompanies(filters, page, 1000, client);
      for (const row of result.companies) yield row;
      if (page * 1000 >= result.total) break;
    }
    await client.query('commit');
    committed = true;
  } finally {
    if (!committed) await client.query('rollback');
    client.release();
  }
}

export * from './manual.js';

export class WebsiteCandidateError extends Error {}

export async function adoptWebsiteCandidate(
  companyId: string,
  factId: string,
  userId: string,
) {
  return transaction(async (client) => {
    const {
      rows: [lock],
    } = await client.query(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked',
      [`site.scan:${companyId}`],
    );
    if (!lock.locked) throw new WebsiteCandidateError('scanRunning');
    const {
      rows: [company],
    } = await client.query(
      'select website from companies where id=$1 for update',
      [companyId],
    );
    const {
      rows: [fact],
    } = await client.query(
      "select value from company_facts where id=$1 and company_id=$2 and kind='website_candidate' and (expires_at is null or expires_at>now()) for share",
      [factId, companyId],
    );
    const site =
      typeof fact?.value === 'string' ? normalizeWebsite(fact.value) : null;
    if (!company || !site) throw new WebsiteCandidateError('staleCandidate');
    if (company.website === site.website) return { changed: false };
    await client.query(
      'update companies set website=$2,domain=$3,updated_at=now() where id=$1',
      [companyId, site.website, site.domain],
    );
    await logActivity(
      'company.website.adopted',
      'company',
      companyId,
      userId,
      { factId, previousWebsite: company.website, website: site.website },
      client,
    );
    const task = await enqueueSiteScan(companyId, userId, client);
    return { changed: true, task };
  });
}
