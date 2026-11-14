import type { ProzorroCompanySnapshot } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { LocalTime } from './local-time';
import { ProzorroSearch } from './prozorro-search';
const amounts = (values: Record<string, number>) =>
  Object.entries(values)
    .map(
      ([currency, amount]) => `${amount.toLocaleString('uk-UA')} ${currency}`,
    )
    .join('; ') || '—';
export function ProzorroCompany({
  companyId,
  snapshot,
}: {
  companyId: string;
  snapshot: ProzorroCompanySnapshot | null;
}) {
  return (
    <div className="space-y-3">
      <ProzorroSearch companyId={companyId} />
      {snapshot ? (
        <>
          <p>
            {uk.prozorro.checkedAt}: <LocalTime value={snapshot.checkedAt} />
          </p>
          <p>
            {uk.prozorro.period}: {snapshot.from} — {snapshot.to}
          </p>
          <p>
            {uk.prozorro.coverage}: {snapshot.inspected} ·{' '}
            {uk.prozorro.searchTotal}: {snapshot.searchTotal}
          </p>
          <p>
            {uk.prozorro.periodCount}: {snapshot.periodParticipationCount}
            {!snapshot.periodCountExact &&
              ` (${uk.prozorro.lowerBound})`} · {uk.prozorro.searchPages}:{' '}
            {snapshot.searchPages}
          </p>
          <p className="text-muted-foreground">{uk.prozorro.sample}</p>
          <p>
            {uk.prozorro.purchases}: {snapshot.matched} · {uk.prozorro.wins}:{' '}
            {snapshot.wins}
          </p>
          <p>
            {uk.prozorro.wonAmount}: {amounts(snapshot.wonAmounts)}
          </p>
          {!!snapshot.unpricedAwards && (
            <p>
              {uk.prozorro.unpricedAwards}: {snapshot.unpricedAwards}
            </p>
          )}
          <p>
            {uk.prozorro.lastParticipation}:{' '}
            {snapshot.lastParticipation ? (
              <LocalTime value={snapshot.lastParticipation} dateOnly />
            ) : (
              '—'
            )}
          </p>
          <p>
            {uk.prozorro.buyers}:{' '}
            {snapshot.topBuyers
              .map((b) => `${b.name} (${b.count})`)
              .join('; ') || '—'}
          </p>
          <p>
            {uk.prozorro.cpv}: {snapshot.cpv.join(', ') || '—'}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  {[
                    uk.prozorro.date,
                    uk.prozorro.buyer,
                    uk.prozorro.tenderTitle,
                    uk.prozorro.amount,
                    uk.prozorro.result,
                  ].map((label) => (
                    <th key={label} className="p-2">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.tenders.map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className="p-2">
                      <LocalTime value={t.date} dateOnly />
                    </td>
                    <td className="p-2">{t.buyer}</td>
                    <td className="p-2">
                      <a
                        className="text-accent"
                        href={t.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t.title || uk.prozorro.untitled}
                      </a>
                    </td>
                    <td className="p-2">
                      {t.amount?.toLocaleString('uk-UA') ?? '—'} {t.currency}
                    </td>
                    <td className="p-2">
                      {t.winner ? uk.prozorro.winner : uk.prozorro.participant}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {snapshot.tenders
            .flatMap((t) => t.contacts)
            .filter(
              (c, i, all) =>
                all.findIndex(
                  (other) => other.kind === c.kind && other.value === c.value,
                ) === i,
            )
            .map((c) => (
              <p key={`${c.kind}:${c.value}`}>
                <a
                  className="text-accent"
                  href={c.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.value}
                </a>{' '}
                · <LocalTime value={c.date} dateOnly />
              </p>
            ))}
        </>
      ) : (
        <p className="text-muted-foreground">{uk.prozorro.empty}</p>
      )}
    </div>
  );
}
