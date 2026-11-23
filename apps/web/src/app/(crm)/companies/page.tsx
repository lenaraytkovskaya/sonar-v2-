import { CompanyList } from '@/components/company-list';
import { filtersFromParams } from '@sonar/core';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (typeof value === 'string') values.set(key, value);
  if (values.has('campaign')) values.set('campaignId', values.get('campaign')!);
  let initialFilters;
  try {
    initialFilters = filtersFromParams(values);
  } catch {
    initialFilters = filtersFromParams(new URLSearchParams());
  }
  return <CompanyList initialFilters={initialFilters} />;
}
