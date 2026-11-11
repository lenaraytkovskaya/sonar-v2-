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
    'select id,number,size,status,found_new,found_known,requests,cost_usd,reason_uk,started_at,finished_at,fixture from batches where campaign_id=$1 order by number desc',
    [id],
  );
  return Response.json({ batches: rows });
}
