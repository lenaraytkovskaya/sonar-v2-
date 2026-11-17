import { CompanyList } from '@/components/company-list';
import { companyFiltersSchema } from '@sonar/core';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; campaignId?: string; status?: string }>;
}) {
  const query = await searchParams;
  const parsed = companyFiltersSchema.safeParse(query);
  const initialFilters = parsed.success
    ? parsed.data
    : companyFiltersSchema.parse({});
  return <CompanyList initialFilters={initialFilters} />;
}
