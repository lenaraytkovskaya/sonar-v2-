import { apiUser } from '@/lib/api-access';
import { filtersFromParams, manualCompanySchema } from '@sonar/core';
import { manualEntryResponse } from '@/lib/manual-entry-response';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const filters = filtersFromParams(params);
    const page = Number(params.get('page') ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      return Response.json({ error: uk.ai.invalid }, { status: 400 });
    const { listCompanies } = await import('@sonar/db/companies');
    return Response.json(
      await listCompanies(filters, page, 25, undefined, {
        groupChains: true,
      }),
    );
  } catch {
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  }
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const parsed = manualCompanySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: uk.manual.errors.invalidCompany },
      { status: 400 },
    );
  const { createManualCompany } = await import('@sonar/db/companies');
  try {
    return Response.json(await createManualCompany(parsed.data, user.id), {
      status: 201,
    });
  } catch (error) {
    return manualEntryResponse(error);
  }
}
