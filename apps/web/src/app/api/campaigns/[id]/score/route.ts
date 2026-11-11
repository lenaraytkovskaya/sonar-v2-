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
  const { rowCount } = await sonarPool.query(
    'select id from campaigns where id=$1',
    [id],
  );
  if (!rowCount)
    return Response.json({ error: uk.ai.invalid }, { status: 404 });
  const { enqueueCampaignScores } = await import('@sonar/db/scoring');
  const count = await enqueueCampaignScores(id, user.id);
  return Response.json({ count }, { status: 202 });
}
