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
    return Response.json({ error: uk.tasks.missing }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  if (
    !(await sonarPool.query('select id from tasks where id=$1', [id])).rowCount
  )
    return Response.json({ error: uk.tasks.missing }, { status: 404 });
  const { retryTask } = await import('@sonar/db/tasks');
  return Response.json({ queued: await retryTask(id, user.id) });
}
