import { prozorroCode } from '@sonar/core';
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
  const body = await request.text();
  let code: string | undefined;
  if (body) {
    try {
      const input = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw Error();
      if ('code' in input) {
        code = prozorroCode(input.code) ?? undefined;
        if (!code) throw Error();
      }
    } catch {
      return Response.json({ error: uk.prozorro.invalidCode }, { status: 400 });
    }
  }
  const { sonarPool } = await import('@sonar/db');
  const { rowCount } = await sonarPool.query(
    'select id from companies where id=$1',
    [id],
  );
  if (!rowCount)
    return Response.json({ error: uk.ai.invalid }, { status: 404 });
  const { enqueueProzorroCompany, ProzorroCodeError } =
    await import('@sonar/db/tasks');
  try {
    const task =
      code === undefined
        ? await enqueueProzorroCompany(id, user.id)
        : await enqueueProzorroCompany(id, user.id, undefined, {
            manualCode: code,
          });
    return Response.json(task, { status: 202 });
  } catch (error) {
    if (error instanceof ProzorroCodeError)
      return Response.json(
        { error: uk.prozorro[error.reason] },
        { status: error.reason === 'invalidCode' ? 400 : 409 },
      );
    throw error;
  }
}
