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
  const { dismissTask } = await import('@sonar/db/tasks');
  return Response.json({ dismissed: await dismissTask(id, user.id) });
}
