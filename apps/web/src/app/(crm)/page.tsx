import { TaskOverview } from '@/components/task-overview';
import { Card, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { uk } from '@/i18n/uk';
import { validId } from '@/lib/api-access';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  const { overviewMetrics } = await import('@sonar/db/metrics');
  const { sonarPool } = await import('@sonar/db');
  const selected = validId(campaign) ? campaign : undefined;
  const [data, campaigns] = await Promise.all([
    overviewMetrics(selected),
    sonarPool.query<{ id: string; name: string }>(
      'select id,name from campaigns order by created_at desc',
    ),
  ]);
  const t = uk.overview;
  return (
    <>
      <PageHeader {...uk.pages.overview} />
      <form className="mb-4 flex flex-wrap items-end gap-3">
        <label className="grid max-w-full gap-1 text-sm">
          {t.campaign}
          <select
            name="campaign"
            defaultValue={selected ?? ''}
            className="min-h-11 max-w-full rounded-lg border border-border bg-surface px-3"
          >
            <option value="">{t.all}</option>
            {campaigns.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" className="min-h-11">
          {uk.finance.apply}
        </Button>
      </form>
      <Card className="mb-4 p-4">
        <h2 className="mb-2 font-heading font-bold">{t.funnel}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t.funnelHint}</p>
        <ol className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {(
            [
              'found',
              'enriched',
              'ready',
              'contacted',
              'replied',
              'interested',
              'deal',
            ] as const
          ).map((key) => (
            <li key={key} className="rounded-lg bg-raised p-3">
              <p className="text-sm text-muted-foreground">{t.stages[key]}</p>
              <strong className="text-xl tabular-nums">
                {data.funnel[key]}
              </strong>
              <progress
                className="mt-2 h-2 w-full"
                aria-label={t.stages[key]}
                value={data.funnel[key]}
                max={data.funnel.found || 1}
              />
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm">
          {t.stages.refused}: <strong>{data.funnel.refused}</strong> ·{' '}
          {t.stages.doNotContact}: <strong>{data.funnel.doNotContact}</strong>
        </p>
      </Card>
      <Card className="mb-4 p-4">
        <h2 className="mb-3 font-heading font-bold">{t.sent}</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-2">{t.channel}</th>
              <th>{t.today}</th>
              <th>{t.week}</th>
            </tr>
          </thead>
          <tbody>
            {data.channels.map((row) => (
              <tr key={row.channel} className="border-t border-border">
                <td className="py-2">{t.channels[row.channel]}</td>
                <td>{row.today}</td>
                <td>{row.last7Days}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4">
          {t.errors}:{' '}
          <strong className={data.failedTasks24h ? 'text-err' : ''}>
            {data.failedTasks24h}
          </strong>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t.timeHint}</p>
      </Card>
      <TaskOverview />
    </>
  );
}
