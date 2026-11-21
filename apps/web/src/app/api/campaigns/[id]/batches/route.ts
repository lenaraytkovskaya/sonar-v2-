import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    `select b.id,b.number,b.size,b.status,b.found_new,b.found_known,b.requests,b.cost_usd,b.reason_uk,b.started_at,b.finished_at,b.fixture,
      (select count(*)::int from campaign_companies cc where cc.batch_id=b.id) as companies,
      (select count(*)::int from campaign_companies cc join companies co on co.id=cc.company_id where cc.batch_id=b.id and co.status not in ('new','enriching')) as enriched
      from batches b where b.campaign_id=$1 order by b.number desc`,
    [id],
  );
  return Response.json({ batches: rows });
}
