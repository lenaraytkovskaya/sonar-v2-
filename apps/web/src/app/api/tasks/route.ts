import { getSession } from '@/lib/auth';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!(await getSession()).user)
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { sonarPool } = await import('@sonar/db');
  const params = new URL(request.url).searchParams;
  const { rows } = await sonarPool.query(
    `select t.id,t.type,t.status,t.reason_uk,t.attempts,t.result,t.created_at,t.subject_id,c.name as company_name from tasks t left join companies c on t.subject_type='company' and t.subject_id=c.id::text
 where ($1::text is null or t.status::text=$1) and ($2::text is null or t.type=$2) order by t.created_at desc limit 200`,
    [params.get('status') || null, params.get('type') || null],
  );
  const { rows: counts } = await sonarPool.query(
    'select type,status,count(*)::int as count from tasks group by type,status',
  );
  const { overviewFailures, readWorkerHealth } =
    await import('@sonar/db/tasks');
  const { failures, olderFailures } = await overviewFailures();
  const { rows: batches } = await sonarPool.query(
    `select b.id,b.size,b.status,b.found_new,b.found_known,b.requests,b.cost_usd,b.reason_uk,b.fixture,c.name as campaign_name,(select count(*)::int from campaign_companies cc where cc.batch_id=b.id) as companies,(select count(*)::int from campaign_companies cc join companies co on co.id=cc.company_id where cc.batch_id=b.id and co.status='enriching') as enriching,(select count(*)::int from campaign_companies cc join companies co on co.id=cc.company_id where cc.batch_id=b.id and co.status not in ('new','enriching')) as enriched from batches b join campaigns c on c.id=b.campaign_id order by b.started_at desc nulls last,b.number desc limit 20`,
  );
  const { countSentToday } = await import('@sonar/db/email');
  const { rows: unread } = await sonarPool.query(
    "select count(*)::int as count from messages where direction='in' and read_at is null",
  );
  return Response.json({
    workerHealth: await readWorkerHealth(),
    tasks: rows,
    counts,
    failures,
    olderFailures,
    batches,
    sentToday: await countSentToday(),
    unreadCount: unread[0].count,
  });
}
