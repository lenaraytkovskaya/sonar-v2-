import { z } from 'zod';
export const companyStatuses = [
  'new',
  'enriching',
  'ready',
  'contacted',
  'replied',
  'interested',
  'deal',
  'refused',
  'do_not_contact',
] as const;
export const companyFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    campaignId: z.string().uuid().optional(),
    city: z.string().trim().max(200).optional(),
    status: z.enum(companyStatuses).optional(),
    hasWebsite: z.boolean().optional(),
    platforms: z.enum(['all', 'only', 'exclude']).optional(),
    hasPhone: z.boolean().optional(),
    minRating: z.number().finite().min(0).max(5).optional(),
    minScore: z.number().finite().min(0).max(100).optional(),
    sort: z.enum(['score', 'newest']).optional(),
  })
  .strict();
export type CompanyFilters = z.infer<typeof companyFiltersSchema>;
export function filtersFromParams(params: URLSearchParams) {
  const raw: Record<string, unknown> = {};
  for (const key of [
    'q',
    'campaignId',
    'city',
    'status',
    'hasWebsite',
    'platforms',
    'hasPhone',
    'minRating',
    'minScore',
    'sort',
  ]) {
    const value = params.get(key);
    if (value === null || value === '') continue;
    raw[key] =
      key === 'minRating' || key === 'minScore'
        ? Number(value)
        : ['hasWebsite', 'hasPhone'].includes(key)
          ? value === 'true'
            ? true
            : value === 'false'
              ? false
              : value
          : value;
  }
  return companyFiltersSchema.parse(raw);
}
export function parseCompanyFilters(raw: string) {
  return companyFiltersSchema.parse(JSON.parse(raw));
}
export function csvRow(values: unknown[]) {
  return (
    values
      .map((value) => {
        let s = String(value ?? '');
        if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replaceAll('"', '""') + '"';
      })
      .join(',') + '\r\n'
  );
}
