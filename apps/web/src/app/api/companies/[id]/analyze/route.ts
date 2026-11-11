import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const campaignId = new URL(request.url).searchParams.get('campaignId');
  if (!validId(id) || !validId(campaignId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select id,status,reason_uk,result->>'analysisId' as analysis_id from tasks where type='company.analyze' and subject_id=$1 and payload->>'campaignId'=$2 order by created_at desc,id desc limit 1",
    [id, campaignId],
  );
  return Response.json(rows[0] ?? null);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !validId(data?.campaignId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { enqueueCompanyAnalysis } = await import('@sonar/db/analysis');
  const task = await enqueueCompanyAnalysis(id, data.campaignId, user.id);
  return task
    ? Response.json(task, { status: 202 })
    : Response.json({ error: uk.company.noData }, { status: 404 });
}
