'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { uk } from '@/i18n/uk';
import { CompanyCard, type CompanyCardRow } from './company-card';

const shown = 6;

/** The best-scored companies a campaign has collected, with a way to see them all. */
export function CampaignCompanies({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<{
    companies: CompanyCardRow[];
    total: number;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      campaignId,
      sort: 'score',
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
  const all = '/companies?campaignId=' + campaignId;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-bold">
          {uk.campaign.companies}
          {data && (
            <span className="ml-2 rounded-full bg-chip px-2 text-sm font-medium">
              {data.total}
            </span>
          )}
        </h2>
        {!!data?.total && (
          <Link className="text-sm text-accent" href={all}>
            {uk.campaign.allCompanies} →
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-err">
          {uk.tasks.error}
        </p>
      )}
      {data && !data.total && (
        <p className="text-sm text-muted-foreground">
          {uk.campaign.noCompanies}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {data?.companies.slice(0, shown).map((company) => (
          <CompanyCard
            key={company.id}
            company={company}
            link={(id) => `/companies/${id}?campaignId=${campaignId}`}
          />
        ))}
      </div>
    </section>
  );
}
