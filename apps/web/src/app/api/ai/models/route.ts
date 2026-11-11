import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (!validId(data?.requestId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { enqueueTask } = await import('@sonar/db/tasks');
  const key = `models:${user.id}:${data.requestId}`;
  await enqueueTask('ai.models', key, { userId: user.id });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    'select id from tasks where idempotency_key=$1',
    [key],
  );
  return Response.json({ id: rows[0].id }, { status: 202 });
}
