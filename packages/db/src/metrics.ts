import { sonarPool } from './index.js';

// Match billing attribution without casting arbitrary task payloads to UUIDs.
const attributedTasks = `select t.*,coalesce(b.campaign_id::text,t.payload->>'campaignId',v.campaign_id::text) as campaign_id
 from tasks t left join batches b on b.id=t.batch_id
 left join messages m on m.id::text=t.payload->>'messageId'
 left join conversations v on v.id=m.conversation_id`;

export type FinanceMetrics = {
  month: string;
  totalUsd: number;
  reservedUsd: number;
  monthlyLimitUsd: number;
  remainingUsd: number;
  companyCount: number;
  contactCount: number;
  costPerCompanyUsd: number | null;
  costPerContactUsd: number | null;
  services: {
    code: string;
    name: string;
    spentUsd: number;
    reservedUsd: number;
    limitUsd: number | null;
    remainingUsd: number | null;
  }[];
  campaigns: { id: string | null; name: string | null; spentUsd: number }[];
  daily: { date: string; spentUsd: number }[];
};

export async function financeMetrics(month: string): Promise<FinanceMetrics> {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000'))
    throw new Error('Invalid month');
  const {
    rows: [row],
  } = await sonarPool.query(
    `with bounds as (
    select $1::date::timestamp at time zone 'UTC' as start,
    ($1::date+interval '1 month') at time zone 'UTC' as finish
  ), attributed_tasks as (${attributedTasks}), costs as (
    select s.service_code,s.cost_usd as cost,s.created_at,t.campaign_id,false as reserved
    from spend_events s left join attributed_tasks t on t.id=s.task_id,bounds
    where s.created_at>=start and s.created_at<finish
    union all
    select t.result->>'billingService',(t.result->>'billingEstimate')::numeric,
    (t.result->>'billingAt')::timestamptz,t.campaign_id,true from attributed_tasks t,bounds
    where t.result->>'billingPending'='true' and (t.result->>'billingAt')::timestamptz>=start
    and (t.result->>'billingAt')::timestamptz<finish
  ), totals as (
    select coalesce(sum(cost) filter(where not reserved),0) as spent,
    coalesce(sum(cost) filter(where reserved),0) as reserved from costs
  ) select jsonb_build_object(
    'totalUsd',spent,'reservedUsd',reserved,
    'companyCount',(select count(*) from companies,bounds where created_at>=start and created_at<finish),
    'contactCount',(select count(*) from contacts,bounds where found_at>=start and found_at<finish),
    'services',(select coalesce(jsonb_agg(jsonb_build_object('code',s.code,'name',s.name,
      'limitUsd',s.monthly_limit_usd,'spentUsd',coalesce(c.spent,0),'reservedUsd',coalesce(c.reserved,0),
      'remainingUsd',case when s.monthly_limit_usd is null then null else greatest(0,s.monthly_limit_usd-coalesce(c.spent,0)-coalesce(c.reserved,0)) end) order by s.code),'[]')
      from services s left join (select service_code,sum(cost) filter(where not reserved) as spent,sum(cost) filter(where reserved) as reserved from costs group by service_code) c on c.service_code=s.code),
    'campaigns',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'spentUsd',x.spent) order by c.name,c.id),'[]')
      from (select campaign_id,sum(cost) as spent from costs where not reserved group by campaign_id) x left join campaigns c on c.id::text=x.campaign_id),
    'daily',(select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'spentUsd',coalesce((select sum(cost) from costs where not reserved and (created_at at time zone 'UTC')::date=d::date),0)) order by d)
      from generate_series($1::date::timestamp,$1::date+interval '1 month'-interval '1 day',interval '1 day') d)
  ) as metrics,(select value from settings where key='budget.monthly_usd') as monthly_limit from totals`,
    [`${month}-01`],
  );
  const metrics = row.metrics as Omit<
    FinanceMetrics,
    | 'month'
    | 'monthlyLimitUsd'
    | 'remainingUsd'
    | 'costPerCompanyUsd'
    | 'costPerContactUsd'
  >;
  const monthlyLimitUsd = Number(
    row.monthly_limit ?? process.env.MONTHLY_BUDGET_USD ?? 50,
  );
  return {
    ...metrics,
    month,
    monthlyLimitUsd,
    remainingUsd: Math.max(
      0,
      monthlyLimitUsd - metrics.totalUsd - metrics.reservedUsd,
    ),
    costPerCompanyUsd: metrics.companyCount
      ? metrics.totalUsd / metrics.companyCount
      : null,
    costPerContactUsd: metrics.contactCount
      ? metrics.totalUsd / metrics.contactCount
      : null,
  };
}

export type OverviewMetrics = {
  funnel: Record<
    | 'found'
    | 'enriched'
    | 'ready'
    | 'contacted'
    | 'replied'
    | 'interested'
    | 'deal'
    | 'refused'
    | 'doNotContact',
    number
  >;
  channels: {
    channel: 'email' | 'telegram' | 'whatsapp' | 'form';
    today: number;
    last7Days: number;
  }[];
  failedTasks24h: number;
};

export async function overviewMetrics(
  campaignId?: string,
): Promise<OverviewMetrics> {
  // Status is a current snapshot, so persisted scores/messages retain earlier
  // funnel milestones after a company refuses or is blocked. No history is invented.
  const {
    rows: [row],
  } = await sonarPool.query(
    `with scoped as (
    select c.* from companies c where $1::uuid is null or exists(select 1 from campaign_companies cc where cc.company_id=c.id and cc.campaign_id=$1)
  ), scoped_messages as (
    select m.*,v.company_id from messages m join conversations v on v.id=m.conversation_id where $1::uuid is null or v.campaign_id=$1
  ), milestones as (
    select c.*,
    (c.status in ('ready','contacted','replied','interested','deal')) as is_ready,
    (c.status in ('contacted','replied','interested','deal') or exists(select 1 from scoped_messages m where m.company_id=c.id and m.direction='out' and m.sent_at is not null)) as is_contacted,
    (c.status in ('replied','interested','deal') or exists(select 1 from scoped_messages m where m.company_id=c.id and m.direction='in')) as is_replied
    from scoped c where ($1::uuid is null and c.created_at>=now()-interval '30 days' and c.created_at<=now())
      or ($1::uuid is not null and exists(select 1 from campaign_companies cc where cc.company_id=c.id and cc.campaign_id=$1
      and cc.added_at>=now()-interval '30 days' and cc.added_at<=now()))
  ), stages as (
    select *,is_replied or is_contacted or is_ready as reached_ready from milestones
  ), attributed_tasks as (${attributedTasks})
  select jsonb_build_object(
    'funnel',jsonb_build_object('found',count(*),
      'enriched',count(*) filter(where reached_ready or exists(select 1 from company_scores s where s.company_id=stages.id and ($1::uuid is null or s.campaign_id=$1)) or exists(select 1 from contacts k where k.company_id=stages.id and k.source<>'google') or exists(select 1 from company_facts f where f.company_id=stages.id and f.source not in ('google','manual'))),
      'ready',count(*) filter(where reached_ready),'contacted',count(*) filter(where is_contacted or is_replied),
      'replied',count(*) filter(where is_replied),'interested',count(*) filter(where status in ('interested','deal')),
      'deal',count(*) filter(where status='deal'),'refused',count(*) filter(where status='refused'),
      'doNotContact',count(*) filter(where status='do_not_contact' or exists(select 1 from do_not_contact d where d.company_id=stages.id or (d.kind='company' and d.value_normalized=stages.id::text)))),
    'channels',(select jsonb_agg(jsonb_build_object('channel',channel,'today',today,'last7Days',last7days) order by channel) from (
      select ch.channel,count(m.id) filter(where m.sent_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as today,count(m.id) as last7days
      from (values ('email'),('telegram'),('whatsapp'),('form')) ch(channel) left join scoped_messages m on m.channel=ch.channel and m.direction='out' and m.sent_at>=now()-interval '7 days' and m.sent_at<=now() group by ch.channel) channels),
    'failedTasks24h',(select count(*) from attributed_tasks t where t.status='failed' and coalesce(t.finished_at,t.created_at)>=now()-interval '24 hours'
      and ($1::uuid is null or t.campaign_id=$1::text or (t.campaign_id is null and ((t.subject_type='campaign' and t.subject_id=$1::text) or (t.subject_type='company' and exists(select 1 from scoped c where c.id::text=t.subject_id))))))
  ) as metrics from stages`,
    [campaignId ?? null],
  );
  return row.metrics as OverviewMetrics;
}
