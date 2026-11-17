'use client';
import type { accountHealth } from '@sonar/db/account-health';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { DetailList, InfoTip, Section } from './ui/layout';
import { CrudDialog } from './crud-dialog';
import { LocalTime } from './local-time';
import type { RowAction } from './ui/row-actions';

export type AccountHealth = Awaited<ReturnType<typeof accountHealth>>[number];
const t = uk.accountHealth;
export function HealthBadge({ health }: { health?: AccountHealth }) {
  if (!health) return null;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      <StatusBadge
        status={
          {
            healthy: 'active',
            watch: 'queued',
            warning: 'failed',
            paused: 'paused',
          }[health.status]
        }
      >
        {health.status === 'paused' && health.pauseUntil ? (
          <>
            {t.pausedUntil} <LocalTime value={health.pauseUntil} />
          </>
        ) : (
          t.statuses[health.status]
        )}
      </StatusBadge>
      <InfoTip label={t.title}>{t.hint}</InfoTip>
    </span>
  );
}
export function HealthDetails({ health }: { health?: AccountHealth }) {
  if (!health) return null;
  return (
    <div className="w-full space-y-2">
      <h4 className="text-sm font-semibold">{t.summary}</h4>
      <DetailList
        className="w-full tabular-nums"
        items={[
          { label: t.sent, value: health.sent14Days },
          {
            label: t.replyRate,
            value:
              health.replyRate === null
                ? '—'
                : `${Math.round(health.replyRate * 100)}%`,
          },
          { label: t.quietDays, value: health.daysWithoutAlarms ?? '—' },
          {
            label: t.sessionHours,
            value:
              health.averageSessionHours === null
                ? '—'
                : health.averageSessionHours.toLocaleString('uk-UA', {
                    maximumFractionDigits: 1,
                  }),
          },
          {
            label: t.pausedUntil,
            value: health.pauseUntil ? (
              <LocalTime value={health.pauseUntil} />
            ) : (
              '—'
            ),
            hidden: !health.pauseUntil,
          },
        ]}
      />
    </div>
  );
}
export function healthJournalAction(
  health: AccountHealth | undefined,
  select: (health: AccountHealth) => void,
): RowAction[] {
  return health
    ? [{ kind: 'journal', label: t.journal, onSelect: () => select(health) }]
    : [];
}
export function HealthJournal({
  health,
  onClose,
}: {
  health: AccountHealth | null;
  onClose: () => void;
}) {
  const max = Math.max(1, ...(health?.daily.map((day) => day.sent) ?? []));
  return (
    <CrudDialog
      open={!!health}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t.title}${health ? ` · ${health.name}` : ''}`}
      draft={null}
    >
      {health && (
        <>
          <HealthDetails health={health} />
          <figure className="space-y-3">
            <figcaption className="font-semibold text-sm">{t.daily}</figcaption>
            <div
              className="flex h-28 items-end gap-1"
              role="img"
              aria-label={health.daily
                .map((day) => `${day.date}: ${day.sent}`)
                .join('; ')}
            >
              {health.daily.map((day) => (
                <div
                  key={day.date}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end"
                  title={`${day.date}: ${day.sent}`}
                >
                  <span className="text-center text-[10px] tabular-nums">
                    {day.sent}
                  </span>
                  <span
                    className="block rounded-t-sm bg-accent"
                    style={{ height: `${Math.max(2, (day.sent / max) * 80)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              {health.daily.length > 0 && (
                <>
                  <LocalTime value={health.daily[0]!.date} dateOnly />
                  <LocalTime
                    value={health.daily[health.daily.length - 1]!.date}
                    dateOnly
                  />
                </>
              )}
            </div>
          </figure>
          <h3 className="text-sm font-semibold">{t.events}</h3>
          {!health.events.length && (
            <p className="text-sm text-muted-foreground">{t.noEvents}</p>
          )}
          <ol className="divide-y divide-border">
            {health.events.slice(0, 30).map((event) => (
              <li key={event.id} className="space-y-1 py-3 text-sm break-words">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    {t.kinds[event.kind as keyof typeof t.kinds] ??
                      t.unknownEvent}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <LocalTime value={event.createdAt} />
                  </span>
                </div>
                <p>{event.reasonUk}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </CrudDialog>
  );
}
export function AccountHealthOverview({ health }: { health: AccountHealth[] }) {
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          {t.title}
          <InfoTip>{t.hint}</InfoTip>
        </span>
      }
      description={t.description}
    >
      {!health.length ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <table className="block w-full text-left text-sm md:table">
          <thead className="hidden text-xs text-muted-foreground md:table-header-group">
            <tr>
              {[t.account, t.channel, t.status, t.today, t.alarms].map(
                (label) => (
                  <th className="pb-3 font-medium" key={label}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="block divide-y divide-border md:table-row-group">
            {health.map((account) => (
              <tr
                key={account.accountId}
                className="grid gap-2 py-4 md:table-row"
              >
                <td className="min-w-0 break-words md:py-3 md:pr-3">
                  {account.name}
                </td>
                <td className="md:py-3">
                  {
                    { ...uk.campaign.channelNames, ...uk.social.networks }[
                      account.channel as keyof (typeof uk.campaign.channelNames &
                        typeof uk.social.networks)
                    ]
                  }
                </td>
                <td className="md:py-3">
                  <HealthBadge health={account} />
                </td>
                <td className="tabular-nums md:py-3">
                  <span className="mr-2 text-xs text-muted-foreground md:hidden">
                    {t.today}
                  </span>
                  {account.sentToday} / {account.dailyLimit}
                </td>
                <td className="tabular-nums md:py-3">
                  <span className="mr-2 text-xs text-muted-foreground md:hidden">
                    {t.alarms}
                  </span>
                  {account.alarmCount7Days}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
