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
  const { rows } = await sonarPool.query(
    'select id from companies where id=$1',
    [id],
  );
  if (!rows.length)
    return Response.json(
      { error: uk.manual.errors.companyNotFound },
      { status: 404 },
    );
  const { enqueueEnrichment, logActivity } = await import('@sonar/db/tasks');
  const task = await enqueueEnrichment(id, user.id);
  await logActivity('company.enrich', 'company', id, user.id);
  return Response.json(task, { status: 202 });
}
