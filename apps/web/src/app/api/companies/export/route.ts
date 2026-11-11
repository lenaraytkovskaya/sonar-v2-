import { apiUser } from '@/lib/api-access';
import { filtersFromParams, csvRow, type CompanyFilters } from '@sonar/core';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  let filters: CompanyFilters;
  try {
    filters = filtersFromParams(new URL(request.url).searchParams);
  } catch {
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  }
  const { exportCompanies } = await import('@sonar/db/companies');
  const { logActivity } = await import('@sonar/db/tasks');
  await logActivity('companies.export', 'company', null, user.id, { filters });
  const encoder = new TextEncoder(),
    iterator = exportCompanies(filters);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          '\uFEFF' +
            csvRow([
              uk.company.name,
              uk.company.city,
              uk.company.type,
              uk.company.rating,
              uk.company.score,
              uk.company.website,
              uk.company.phone,
              uk.company.campaign,
              uk.company.status,
              uk.company.date,
            ]),
        ),
      );
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        const row = next.value;
        controller.enqueue(
          encoder.encode(
            csvRow([
              row.name,
              row.city,
              row.primary_type,
              row.rating,
              row.score,
              row.website,
              row.phones.join('; '),
              row.campaigns.map((c) => c.name).join('; '),
              uk.company.statuses[
                row.status as keyof typeof uk.company.statuses
              ],
              new Date(row.created_at).toISOString(),
            ]),
          ),
        );
      } catch (error) {
        await iterator.return();
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="companies.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
