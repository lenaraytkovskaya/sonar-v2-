'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
export function CompanyTabs({
  companyId,
  campaignId,
  active,
}: {
  companyId: string;
  campaignId?: string;
  active: keyof typeof uk.companyTabs;
}) {
  const selected = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <nav
      aria-label={uk.company.tabs}
      className="mb-4 flex max-w-full gap-1 overflow-x-auto border-b border-border"
    >
      {(Object.keys(uk.companyTabs) as (keyof typeof uk.companyTabs)[]).map(
        (key) => {
          const query = new URLSearchParams({ tab: key });
          if (campaignId) query.set('campaignId', campaignId);
          return (
            <Link
              key={key}
              ref={active === key ? selected : undefined}
              href={`/companies/${companyId}?${query}`}
              aria-current={active === key ? 'page' : undefined}
              className={cn(
                'shrink-0 border-b-2 border-transparent px-4 py-3 text-sm hover:text-accent',
                active === key
                  ? 'border-accent font-semibold text-accent'
                  : 'text-muted-foreground',
              )}
            >
              {uk.companyTabs[key]}
            </Link>
          );
        },
      )}
    </nav>
  );
}
