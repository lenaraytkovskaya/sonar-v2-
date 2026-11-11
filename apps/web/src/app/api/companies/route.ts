import { apiUser } from '@/lib/api-access';
import { filtersFromParams } from '@sonar/core';
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
    return Response.json(await listCompanies(filters, page));
  } catch {
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  }
}
