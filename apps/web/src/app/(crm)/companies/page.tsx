import { CompanyList } from '@/components/company-list';
import { validId } from '@/lib/api-access';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ campaignId?: string }>;
}) {
  const { campaignId } = await searchParams;
  return (
    <CompanyList
      initialCampaignId={validId(campaignId) ? campaignId : undefined}
    />
  );
}
