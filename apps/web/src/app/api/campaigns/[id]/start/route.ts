import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const {
    rows: [campaign],
  } = await sonarPool.query('select * from campaigns where id=$1', [id]);
  if (!campaign?.cities.length || !campaign?.queries.length)
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { enqueueTask, logActivity } = await import('@sonar/db/tasks');
  const taskId = await enqueueTask(
    'google.batch',
    `google:${id}:${crypto.randomUUID()}`,
    { campaignId: id },
  );
  await logActivity('campaign.start', 'campaign', id, user.id, { taskId });
  return Response.json({ id: taskId }, { status: 202 });
}
