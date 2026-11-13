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
  const { getCompanySocial } = await import('@sonar/db/social');
  return Response.json(await getCompanySocial(id));
}

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
  if (
    !(await sonarPool.query('select 1 from companies where id=$1', [id]))
      .rowCount
  )
    return Response.json(
      { error: uk.manual.errors.companyNotFound },
      { status: 404 },
    );
  const { enqueueCompanySocial, getCompanySocial } =
    await import('@sonar/db/social');
  await enqueueCompanySocial(id, user.id);
  return Response.json(await getCompanySocial(id), { status: 202 });
}
