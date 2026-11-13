import { FilterPanel } from '@/components/filter-panel';
import { Card, PageHeader, scoreTone } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { uk } from '@/i18n/uk';
const money = (value: number | null) =>
  value === null
    ? '—'
    : new Intl.NumberFormat('uk-UA', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      }).format(value);
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  const { financeMetrics } = await import('@sonar/db/metrics');
  const selected =
    typeof month === 'string' &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
    Number(month.slice(0, 4)) > 0
      ? month
      : new Date().toISOString().slice(0, 7);
  const data = await financeMetrics(selected);
  const t = uk.finance;
  const peak = Math.max(...data.daily.map((day) => day.spentUsd), 0.001);
  return (
    <>
      <PageHeader {...uk.pages.finance} />
      <FilterPanel count={month === selected ? 1 : 0} resetHref="/finance">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            {t.month}
            <input
              className="min-h-11 rounded-lg border border-border bg-surface px-3"
              type="month"
              name="month"
              defaultValue={data.month}
              required
            />
          </label>
          <Button type="submit" className="min-h-11">
            {t.apply}
          </Button>
        </form>
      </FilterPanel>
      <p className="mb-4 text-sm text-muted-foreground">{t.periodHint}</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [t.spent, data.totalUsd],
          [t.budget, data.monthlyLimitUsd],
          [t.reserved, data.reservedUsd],
          [t.remaining, data.remainingUsd],
        ].map(([label, value]) => (
          <Card className="p-4" key={String(label)}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <strong
              className={
                'text-xl tabular-nums ' +
                (label === t.remaining
                  ? scoreTone(
                      data.monthlyLimitUsd > 0
                        ? (data.remainingUsd / data.monthlyLimitUsd) * 100
                        : null,
                    ).text
                  : '')
              }
            >
              {money(Number(value))}
            </strong>
          </Card>
        ))}
      </div>
      <Card className="mb-4 p-4">
        <h2 className="mb-4 font-heading font-bold">{t.daily}</h2>
        <div className="overflow-x-auto">
          <div
            className="flex min-w-[580px] items-end gap-1"
            role="img"
            aria-label={t.daily}
          >
            {data.daily.map((day) => (
              <div
                key={day.date}
                className="flex flex-1 flex-col items-center gap-2"
                title={`${day.date}: ${money(day.spentUsd)}`}
              >
                <div className="flex h-36 w-full items-end">
                  <div
                    className="w-full rounded-t bg-accent"
                    style={{ height: `${(day.spentUsd / peak) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {day.date.slice(-2)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer">{t.dailyValues}</summary>
          <dl className="mt-2 grid gap-2 sm:grid-cols-3">
            {data.daily.map((day) => (
              <div key={day.date} className="flex justify-between gap-2">
                <dt>{day.date}</dt>
                <dd>{money(day.spentUsd)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </Card>
      <Card className="mb-4 overflow-x-auto p-4">
        <h2 className="mb-3 font-heading font-bold">{t.services}</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {[t.service, t.spent, t.budget, t.reserved, t.remaining].map(
                (label) => (
                  <th key={label} className="p-2">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {data.services.map((service) => (
              <tr key={service.code} className="border-t border-border">
                <td className="p-2">{service.name}</td>
                <td className="p-2 tabular-nums">{money(service.spentUsd)}</td>
                <td className="p-2 tabular-nums">
                  {service.limitUsd === null
                    ? t.unlimited
                    : money(service.limitUsd)}
                </td>
                <td className="p-2 tabular-nums">
                  {money(service.reservedUsd)}
                </td>
                <td
                  className={
                    'p-2 tabular-nums ' +
                    scoreTone(
                      service.remainingUsd !== null &&
                        service.limitUsd !== null &&
                        service.limitUsd > 0
                        ? (service.remainingUsd / service.limitUsd) * 100
                        : null,
                    ).text
                  }
                >
                  {service.remainingUsd === null
                    ? t.unlimited
                    : money(service.remainingUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 font-heading font-bold">{t.campaigns}</h2>
          <dl className="space-y-2">
            {data.campaigns.map((campaign) => (
              <div
                key={campaign.id ?? 'none'}
                className="flex justify-between gap-3"
              >
                <dt>{campaign.name ?? t.unassigned}</dt>
                <dd className="tabular-nums">{money(campaign.spentUsd)}</dd>
              </div>
            ))}
          </dl>
          {!data.campaigns.length && (
            <p className="text-muted-foreground">{t.empty}</p>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 font-heading font-bold">{t.unitCosts}</h2>
          <dl className="space-y-2">
            <div className="flex justify-between gap-3">
              <dt>
                {t.perCompany} ({data.companyCount})
              </dt>
              <dd>{money(data.costPerCompanyUsd)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>
                {t.perContact} ({data.contactCount})
              </dt>
              <dd>{money(data.costPerContactUsd)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-muted-foreground">{t.unitHint}</p>
        </Card>
      </div>
    </>
  );
}
