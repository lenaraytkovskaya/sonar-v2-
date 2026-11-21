import { AccountHealthOverview } from '@/components/account-health';
import {
  RecentFailuresCallout,
  TaskOverview,
} from '@/components/task-overview';
import Link from 'next/link';
import { PageHeader, StatusBadge } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { InfoTip, Section } from '@/components/ui/layout';
import { uk } from '@/i18n/uk';
import { validId } from '@/lib/api-access';

const stages = [
  'found',
  'enriched',
  'ready',
  'contacted',
  'replied',
  'interested',
  'deal',
] as const;
const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '—';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  const { accountHealth } = await import('@sonar/db/account-health');
  const { overviewMetrics } = await import('@sonar/db/metrics');
  const { sonarPool } = await import('@sonar/db');
  const { manualExpenseReminders } = await import('@sonar/db/manual-expenses');
  const selected = validId(campaign) ? campaign : undefined;
  const [data, campaigns, health, renewalData, campaignRows] =
    await Promise.all([
      overviewMetrics(selected),
      sonarPool.query<{ id: string; name: string }>(
        'select id,name from campaigns order by created_at desc',
      ),
      accountHealth(),
      manualExpenseReminders(),
      sonarPool.query<{
        id: string;
        name: string;
        status: keyof typeof uk.campaign.statuses;
        found: number;
        ready: number;
        contacted: number;
        replied: number;
      }>(
        `select c.id,c.name,c.status,count(cc.company_id)::int as found,
        count(*) filter (where co.status<>'new' and co.status<>'enriching')::int as ready,
        count(*) filter (where co.status in ('contacted','replied','interested','deal'))::int as contacted,
        count(*) filter (where co.status in ('replied','interested','deal'))::int as replied
       from campaigns c left join campaign_companies cc on cc.campaign_id=c.id left join companies co on co.id=cc.company_id
       where c.status<>'archived' group by c.id order by c.created_at desc`,
      ),
    ]);
  const t = uk.overview;
  const f = data.funnel;
  const kpis = [
    { key: 'found', value: f.found, note: t.kpiNotes.found },
    {
      key: 'ready',
      value: f.ready,
      note: `${percent(f.ready, f.found)} ${t.kpiNotes.ofFound}`,
    },
    {
      key: 'contacted',
      value: f.contacted,
      note: `${percent(f.contacted, f.ready)} ${t.kpiNotes.ofReady}`,
    },
    {
      key: 'replied',
      value: f.replied,
      note: `${percent(f.replied, f.contacted)} ${t.kpiNotes.ofContacted}`,
    },
  ] as const;
  return (
    <div className="space-y-6">
      <PageHeader
        {...uk.pages.overview}
        actions={
          <form className="flex flex-wrap items-center gap-2">
            <select
              name="campaign"
              aria-label={t.campaign}
              defaultValue={selected ?? ''}
              className="min-h-9 max-w-64 rounded-lg border border-border bg-surface px-3 text-sm shadow-xs"
            >
              <option value="">{t.all}</option>
              {campaigns.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="outline">
              {uk.finance.apply}
            </Button>
          </form>
        }
      />
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <li
            key={kpi.key}
            className="rounded-xl border border-border bg-surface p-5 shadow-xs"
          >
            <p className="text-sm text-muted-foreground">{t.stages[kpi.key]}</p>
            <p className="mt-1 font-heading text-3xl font-bold tabular-nums">
              {kpi.value}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">{kpi.note}</p>
          </li>
        ))}
      </ul>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section
          title={
            <span className="inline-flex items-center gap-2">
              {t.funnel}
              <InfoTip>{t.funnelHint}</InfoTip>
            </span>
          }
        >
          <ol className="space-y-3">
            {stages.map((key) => (
              <li
                key={key}
                className="grid grid-cols-[8rem_minmax(0,1fr)_3.5rem] items-center gap-3 text-sm"
              >
                <span className="text-muted-foreground">{t.stages[key]}</span>
                <span className="h-2 overflow-hidden rounded-full bg-chip">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{
                      width: `${f.found ? Math.max((f[key] / f.found) * 100, f[key] ? 2 : 0) : 0}%`,
                    }}
                  />
                </span>
                <span className="text-right font-medium tabular-nums">
                  {f[key]}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            {t.stages.refused}:{' '}
            <span className="font-medium text-foreground tabular-nums">
              {f.refused}
            </span>{' '}
            · {t.stages.doNotContact}:{' '}
            <span className="font-medium text-foreground tabular-nums">
              {f.doNotContact}
            </span>
          </p>
        </Section>
        <Section
          title={
            <span className="inline-flex items-center gap-2">
              {t.sent}
              <InfoTip>{t.timeHint}</InfoTip>
            </span>
          }
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">{t.channel}</th>
                <th className="pb-2 text-right font-medium">{t.today}</th>
                <th className="pb-2 text-right font-medium">{t.week}</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((row) => (
                <tr key={row.channel} className="border-t border-border">
                  <td className="py-2.5">{t.channels[row.channel]}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {row.today}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {row.last7Days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4">
            <RecentFailuresCallout />
          </div>
        </Section>
      </div>
      <Section title={t.campaignsTitle}>
        {campaignRows.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.campaignsEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">{t.campaignName}</th>
                  <th className="pb-2 font-medium">{t.campaignState}</th>
                  {(['found', 'ready', 'contacted', 'replied'] as const).map(
                    (key) => (
                      <th key={key} className="pb-2 text-right font-medium">
                        {t.stages[key]}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {campaignRows.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2.5">
                      <Link
                        href={`/campaigns?campaign=${row.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={row.status}>
                        {uk.campaign.statuses[row.status]}
                      </StatusBadge>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {row.found}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {row.ready}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {row.contacted}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {row.replied}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <AccountHealthOverview health={health} />
      {renewalData.reminders.length > 0 && (
        <Section title={uk.finance.renewalReminders}>
          <ul className="divide-y divide-border">
            {renewalData.reminders.map((reminder) => (
              <li
                key={reminder.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 font-medium">{reminder.title}</span>
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={
                      reminder.status === 'overdue'
                        ? 'font-medium text-err'
                        : 'text-wait'
                    }
                  >
                    {reminder.status === 'overdue'
                      ? uk.finance.overdue
                      : uk.finance.upcoming}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {uk.finance.dueOn}: {reminder.paid_until}
                  </span>
                  <Button asChild variant="outline" className="min-h-10">
                    <a href="/finance">{uk.finance.continue}</a>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <TaskOverview />
    </div>
  );
}
