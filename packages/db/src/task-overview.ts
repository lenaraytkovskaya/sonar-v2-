import { sonarPool } from './index.js';
import { campaignTaskScope } from './campaign-task-scope.js';
import { overviewFailures } from './tasks.js';
export async function taskOverviewData({
  campaignId,
  status = null,
  type = null,
}: { campaignId?: string; status?: string | null; type?: string | null } = {}) {
  if (
    campaignId &&
    !(
      await sonarPool.query('select id from campaigns where id=$1', [
        campaignId,
      ])
    ).rows[0]
  )
    return null;
  const [{ rows: tasks }, { rows: counts }, { rows: batches }, failures] =
    await Promise.all([
      sonarPool.query(
        `select t.id,t.type,t.status,t.reason_uk,t.attempts,t.result,t.created_at,t.subject_id,c.name as company_name
      from tasks t left join companies c on t.subject_type='company' and t.subject_id=c.id::text
      where ($1::uuid is null or ${campaignTaskScope()}) and ($2::text is null or t.status::text=$2) and ($3::text is null or t.type=$3)
      order by t.created_at desc limit 200`,
        [campaignId ?? null, status, type],
      ),
      sonarPool.query(
        `select t.type,t.status,count(*)::int as count from tasks t where ($1::uuid is null or ${campaignTaskScope()}) group by t.type,t.status`,
        [campaignId ?? null],
      ),
      sonarPool.query(
        `select b.id,b.size,b.status,b.found_new,b.found_known,b.requests,b.cost_usd,b.reason_uk,b.fixture,c.name as campaign_name,
      (select count(*)::int from campaign_companies cc where cc.batch_id=b.id) as companies,
      (select count(*)::int from campaign_companies cc join companies co on co.id=cc.company_id where cc.batch_id=b.id and co.status='enriching') as enriching,
      (select count(*)::int from campaign_companies cc join companies co on co.id=cc.company_id where cc.batch_id=b.id and co.status not in ('new','enriching')) as enriched
      from batches b join campaigns c on c.id=b.campaign_id where ($1::uuid is null or b.campaign_id=$1::uuid) order by b.started_at desc nulls last,b.number desc limit 20`,
        [campaignId ?? null],
      ),
      overviewFailures(campaignId),
    ]);
  return { tasks, counts, batches, ...failures };
}
