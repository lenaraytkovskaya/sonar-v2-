import {
  companyFiltersSchema,
  type CompanyFilters,
  type ScoreBreakdown,
} from '@sonar/core';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';
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
  phones: string[];
  campaigns: { id: string; name: string }[];
};
export type CompanyScoreRow = {
  campaign_id: string;
  campaign_name: string;
  score: number;
  breakdown: ScoreBreakdown;
  computed_at: Date;
};
export async function listCompanies(
  filters: CompanyFilters,
  page = 1,
  pageSize = 25,
  connection: Pick<PoolClient, 'query'> = sonarPool,
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
  const order = `${sort === 'score' ? 'score desc nulls last,' : ''}c.created_at desc,c.id`;
  const {
    rows: [count],
  } = await connection.query(
    `select count(*)::int as total from companies c ${sql}`,
    values,
  );
  const { rows } = await connection.query<CompanyRow>(
    `select c.id,c.name,c.city,c.primary_type,c.rating,${scoreSql} as score,c.website,c.domain,c.status,c.created_at,
 array(select p.normalized from contacts p where p.company_id=c.id and p.kind='phone' order by p.rank desc,p.normalized) as phones,
 coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name) from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=c.id),'[]') as campaigns
 from companies c ${sql} order by ${order} limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, pageSize, (page - 1) * pageSize],
  );
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
  ] = await Promise.all([
    sonarPool.query(
      'select * from contacts where company_id=$1 order by rank desc,found_at desc',
      [id],
    ),
    sonarPool.query(
      'select c.id,c.name,b.id as batch_id,b.number,b.status,cc.added_at from campaign_companies cc join campaigns c on c.id=cc.campaign_id join batches b on b.id=cc.batch_id where cc.company_id=$1 order by cc.added_at desc',
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
  ]);
  return { company, contacts, campaigns, history, facts, scans, scores };
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
