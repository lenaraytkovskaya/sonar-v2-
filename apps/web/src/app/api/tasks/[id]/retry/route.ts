import { getSession } from '@/lib/auth';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = (await getSession()).user;
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && new URL(origin).host === host;
  } catch {
    /* Reject malformed origins. */
  }
  if (!sameOrigin)
    return Response.json({ error: uk.unauthorized }, { status: 403 });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
    return Response.json({ error: uk.tasks.missing }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  if (
    !(await sonarPool.query('select id from tasks where id=$1', [id])).rowCount
  )
    return Response.json({ error: uk.tasks.missing }, { status: 404 });
  const { retryTask } = await import('@sonar/db/tasks');
  return Response.json({ queued: await retryTask(id, user.id) });
}
