import { ManualSourceError, manualSourceSchema } from '@sonar/core';
import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const source = manualSourceSchema.shape.source.safeParse(
    params.get('source'),
  );
  const requestId = params.get('requestId');
  if (!validId(id) || !source.success || (requestId && !validId(requestId)))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { getManualSource } = await import('@sonar/db/companies');
  return Response.json(
    await getManualSource(id, source.data, requestId ?? undefined),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const input = manualSourceSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!validId(id) || !input.success)
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { saveManualSource } = await import('@sonar/db/companies');
  const { ProzorroCodeError } = await import('@sonar/db/tasks');
  try {
    return Response.json(await saveManualSource(id, input.data, user.id), {
      status: 202,
    });
  } catch (error) {
    const code =
      error instanceof ManualSourceError
        ? error.code
        : error instanceof ProzorroCodeError
          ? error.reason === 'companyBusy'
            ? 'sourceBusy'
            : error.reason
          : null;
    if (!code)
      return Response.json({ error: uk.manualSource.error }, { status: 503 });
    return Response.json(
      { error: uk.manualSource.errors[code] },
      {
        status:
          code === 'companyNotFound'
            ? 404
            : ['sourceBusy', 'staleSource', 'conflictingCode'].includes(code)
              ? 409
              : 400,
      },
    );
  }
}
