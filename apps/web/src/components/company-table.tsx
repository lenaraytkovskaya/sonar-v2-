import Link from 'next/link';
import { Network, Store } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { ChannelIcon } from './channel-icon';
import { CompanyStatus, Score } from './shared';
import type { CompanyCardRow } from './company-card';

const channelOrder = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'booking',
  'social',
] as const;

/** Companies as a data table (DESIGN.md §2): one row per company, the main facts in fixed columns. */
export function CompanyTable({
  companies,
  link,
}: {
  companies: CompanyCardRow[];
  link: (id: string) => string;
}) {
  const t = uk.company;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
      <table className="w-full min-w-[960px] text-sm">
        <thead className="bg-raised text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">{t.tableName}</th>
            <th className="px-3 py-3 font-medium">{t.score}</th>
            <th className="px-3 py-3 font-medium">{t.fit}</th>
            <th className="px-3 py-3 font-medium">{t.channels}</th>
            <th className="px-3 py-3 font-medium">{t.tableContact}</th>
            <th className="px-3 py-3 font-medium">{t.tableRating}</th>
            <th className="px-3 py-3 font-medium">{t.status}</th>
            <th className="px-4 py-3 text-right font-medium">{t.tableAdded}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {companies.map((c) => (
            <tr key={c.id} className="align-top hover:bg-raised/60">
              <td className="max-w-80 px-4 py-3">
                <Link
                  href={link(c.id)}
                  className="line-clamp-2 font-medium text-foreground hover:text-accent"
                  title={c.name}
                >
                  {c.name}
                </Link>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[c.city, c.primary_type].filter(Boolean).join(' · ') || '—'}
                </p>
                {(c.chain_size > 1 || c.platform) && (
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {c.chain_size > 1 && (
                      <span className="inline-flex items-center gap-1">
                        <Network aria-hidden="true" className="size-3" />
                        {t.chain}: {c.chain_size}
                      </span>
                    )}
                    {c.platform && (
                      <span
                        className="inline-flex items-center gap-1 text-wait"
                        title={t.platformHint}
                      >
                        <Store aria-hidden="true" className="size-3" />
                        {t.platform}
                      </span>
                    )}
                  </p>
                )}
              </td>
              <td className="px-3 py-3">
                <Score value={c.score} compact />
              </td>
              <td className="px-3 py-3">
                <Score value={c.fit} compact label={t.fit} />
              </td>
              <td className="px-3 py-3">
                <span
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label={t.channels}
                >
                  {channelOrder
                    .filter((kind) => c.channels.includes(kind))
                    .map((kind) => (
                      <span key={kind} title={t.kinds[kind]}>
                        <ChannelIcon channel={kind} className="size-4" />
                      </span>
                    ))}
                  {c.registry && (
                    <span className="rounded bg-run-bg px-1.5 py-0.5 text-[11px] font-medium text-run">
                      {t.registry}
                    </span>
                  )}
                  {!c.channels.length && !c.registry && (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </span>
              </td>
              <td className="max-w-56 px-3 py-3">
                {c.emails[0] && (
                  <a
                    className="block truncate hover:text-accent"
                    href={'mailto:' + c.emails[0]}
                  >
                    {c.emails[0]}
                  </a>
                )}
                {c.phones[0] && (
                  <a
                    className="block tabular-nums hover:text-accent"
                    href={'tel:' + c.phones[0]}
                  >
                    {c.phones[0]}
                    {c.phones.length > 1 && (
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        +{c.phones.length - 1}
                      </span>
                    )}
                  </a>
                )}
                {c.website && (
                  <a
                    className="block truncate text-xs text-accent"
                    target="_blank"
                    rel="noreferrer"
                    href={c.website}
                  >
                    {c.domain ?? c.website}
                  </a>
                )}
                {!c.emails[0] && !c.phones[0] && !c.website && (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                {c.rating ? (
                  <>
                    <span className="text-wait">★</span> {c.rating}
                    {c.ratings_count ? (
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        · {c.ratings_count}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-3">
                <CompanyStatus status={c.status} />
              </td>
              <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {new Date(c.created_at).toLocaleDateString('uk-UA')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
