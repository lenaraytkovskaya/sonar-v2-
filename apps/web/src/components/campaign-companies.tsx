'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { uk } from '@/i18n/uk';

/** A compact link to the campaign company list. */
export function CampaignCompanies({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<{
    total: number;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      campaignId,
      sort: 'quality',
      page: '1',
    });
    fetch('/api/companies?' + params, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error();
        setData(await response.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [campaignId]);
  return (
    <div className="text-sm">
      <CampaignCompaniesLink campaignId={campaignId} total={data?.total} />
      {error && (
        <p role="alert" className="mt-2 text-err">
          {uk.tasks.error}
        </p>
      )}
    </div>
  );
}

export function CampaignCompaniesLink({
  campaignId,
  total,
}: {
  campaignId: string;
  total?: number;
}) {
  return (
    <Link
      className="text-accent hover:underline"
      href={'/companies?campaign=' + campaignId}
    >
      {uk.campaign.companies}: {total ?? '…'} →
    </Link>
  );
}
