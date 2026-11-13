'use client';
import { useState } from 'react';
import { socialTarget } from '@sonar/core';
import { RowActions } from './ui/row-actions';
import Link from 'next/link';
import { Network, Store } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { ChannelIcon } from './channel-icon';
import { Card, CompanyStatus, Score, scoreTone } from './shared';
export type CompanyCardRow = {
  id: string;
  name: string;
  city: string | null;
  primary_type: string | null;
  rating: string | null;
  score: number | null;
  website: string | null;
  status: keyof typeof uk.company.statuses;
  created_at: string;
  ratings_count: number | null;
  phones: string[];
  emails: string[];
  channels: string[];
  socials?: string[];
  registry: boolean;
  platform: boolean;
  domain: string | null;
  chain_size: number;
  branches?: { id: string; name: string; address: string | null }[];
  campaigns: { id: string; name: string }[];
};
const channelOrder = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
] as const;
export function CompanyCard({
  company: c,
  link,
}: {
  company: CompanyCardRow;
  link: (id: string) => string;
}) {
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const block = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/companies/${c.id}/outreach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'block' }),
      });
      if (!response.ok)
        throw Error((await response.json()).error ?? uk.email.error);
      setBlocked(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      setPending(false);
    }
  };
  const networks = [
    ...new Set(
      (c.socials ?? []).flatMap((value) => socialTarget(value)?.network ?? []),
    ),
  ];
  return (
    <Card className="flex min-w-0 flex-col gap-2.5 p-3.5">
      <div className="flex min-h-11 items-start justify-between gap-2">
        <Link
          className="line-clamp-2 min-w-0 font-semibold leading-snug text-foreground hover:text-accent"
          href={link(c.id)}
          title={c.name}
        >
          {c.name}
        </Link>
        <CompanyStatus status={blocked ? 'do_not_contact' : c.status} />
        {!blocked && c.status !== 'do_not_contact' && (
          <RowActions
            disabled={pending}
            actions={[
              {
                kind: 'block',
                label: uk.email.block,
                danger: true,
                onSelect: () => void block(),
              },
            ]}
          />
        )}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          <p className="truncate">
            {[c.city, c.primary_type].filter(Boolean).join(' · ') || '—'}
          </p>
          <p>
            <span
              className={
                scoreTone(c.rating === null ? null : Number(c.rating) * 20).text
              }
            >
              ★
            </span>{' '}
            {c.rating ?? '—'}
            {c.ratings_count ? (
              <>
                {' '}
                · {c.ratings_count} {uk.company.reviews}
              </>
            ) : null}
          </p>
        </div>
        <Score value={c.score} compact />
      </div>
      <div className="flex flex-wrap gap-1" aria-label={uk.company.channels}>
        {channelOrder
          .filter((kind) => c.channels.includes(kind))
          .map((kind) => (
            <span
              key={kind}
              className="inline-flex items-center gap-1 rounded bg-chip px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              {kind === 'social' && networks.length ? (
                networks.map((network) => (
                  <ChannelIcon key={network} channel={network} />
                ))
              ) : (
                <ChannelIcon channel={kind} />
              )}{' '}
              {uk.company.kinds[kind]}
            </span>
          ))}
        {c.registry && (
          <span className="rounded bg-run-bg px-1.5 py-0.5 text-[11px] font-medium text-run">
            {uk.company.registry}
          </span>
        )}
        {c.platform && (
          <span
            className="inline-flex items-center gap-1 rounded bg-wait-bg px-1.5 py-0.5 text-[11px] font-medium text-wait"
            title={uk.company.platformHint}
          >
            <Store aria-hidden="true" className="size-3" />
            {uk.company.platform}
          </span>
        )}
        {!c.channels.length && (
          <span className="text-xs text-muted-foreground">
            {uk.company.noContacts}
          </span>
        )}
      </div>
      <div className="min-w-0 space-y-0.5 text-sm">
        {c.website && (
          <a
            className="block truncate text-accent"
            target="_blank"
            rel="noreferrer"
            href={c.website}
          >
            <ChannelIcon channel="site" /> {c.domain ?? c.website}
          </a>
        )}
        {c.emails[0] && (
          <a className="block truncate" href={'mailto:' + c.emails[0]}>
            <ChannelIcon channel="email" /> {c.emails[0]}
          </a>
        )}
        {c.phones[0] && (
          <a className="block tabular-nums" href={'tel:' + c.phones[0]}>
            <ChannelIcon channel="phone" /> {c.phones[0]}
            {c.phones.length > 1 && (
              <span className="text-xs text-muted-foreground">
                {' '}
                +{c.phones.length - 1}
              </span>
            )}
          </a>
        )}
      </div>
      {c.chain_size > 1 && (
        <details className="rounded-lg bg-raised px-2.5 py-1.5 text-sm">
          <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
            <Network aria-hidden="true" className="size-3.5 text-accent" />
            {uk.company.chain}: {c.chain_size} {uk.company.branches}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {c.branches?.map((branch) => (
              <li key={branch.id} className="min-w-0">
                <Link
                  className="block truncate text-accent"
                  href={link(branch.id)}
                >
                  {branch.name}
                </Link>
                {branch.address && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {branch.address}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="text-xs text-err">
          {error}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {c.campaigns.map((a) => a.name).join(', ')}
        </span>
        <span className="shrink-0">
          {new Date(c.created_at).toLocaleDateString('uk-UA')}
        </span>
      </div>
    </Card>
  );
}
