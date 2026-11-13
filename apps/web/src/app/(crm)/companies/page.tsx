import { CompanyList } from '@/components/company-list';
import { filtersFromParams } from '@sonar/core';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );
  let initialFilters;
  try {
    initialFilters = filtersFromParams(params);
  } catch {
    initialFilters = {};
  }
  return (
    <CompanyList
      key={JSON.stringify(initialFilters)}
      initialFilters={initialFilters}
    />
  );
}
