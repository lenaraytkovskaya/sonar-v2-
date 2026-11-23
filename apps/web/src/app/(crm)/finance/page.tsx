import { Card, PageHeader } from '@/components/shared';
import { InfoTip } from '@/components/ui/layout';
import Link from 'next/link';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { uk } from '@/i18n/uk';
import { ManualExpenses } from '@/components/manual-expenses';
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
  const { listManualExpenses, listManualExpenseAccounts } =
    await import('@sonar/db/manual-expenses');
  const selected =
    typeof month === 'string' &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
    Number(month.slice(0, 4)) > 0
      ? month
      : new Date().toISOString().slice(0, 7);
  const [data, manualExpenses, accounts] = await Promise.all([
    financeMetrics(selected),
    listManualExpenses(selected),
    listManualExpenseAccounts(),
  ]);
  const t = uk.finance;
  const manualUsd = manualExpenses.reduce(
    (sum, row) => sum + Number(row.amount_usd),
    0,
  );
  const peak = Math.max(...data.daily.map((day) => day.spentUsd), 0.001);
  return (
    <>
      <PageHeader
        {...uk.pages.finance}
        actions={
          <AutoFilterForm
            key={selected}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              aria-label={t.month}
              className="min-h-9 rounded-lg border border-border bg-surface px-3 text-sm shadow-xs"
              type="month"
              name="month"
              defaultValue={data.month}
              required
            />
            {month && (
              <Link
                href="/finance"
                className="text-sm underline underline-offset-4"
              >
                {uk.company.reset}
              </Link>
            )}
            <InfoTip>{t.periodHint}</InfoTip>
          </AutoFilterForm>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          [t.automatic, data.totalUsd],
          [t.manualTotal, manualUsd],
          [t.totalMonth, data.totalUsd + manualUsd],
          [t.budget, data.monthlyLimitUsd],
          [t.reserved, data.reservedUsd],
          [t.remaining, data.remainingUsd],
        ].map(([label, value]) => (
          <Card className="p-5" key={String(label)}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <strong className="mt-1 block font-heading text-3xl font-bold tabular-nums">
              {money(Number(value))}
            </strong>
          </Card>
        ))}
      </div>
      <ManualExpenses
        month={data.month}
        expenses={manualExpenses}
        accounts={accounts}
      />
      <Card className="mb-6 p-5">
        <h2 className="mb-4 font-heading text-base font-semibold">{t.daily}</h2>
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
      <Card className="mb-6 overflow-x-auto p-5">
        <h2 className="mb-3 font-heading text-base font-semibold">
          {t.services}
        </h2>
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
                <td className="p-2 tabular-nums">
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
          <h2 className="mb-3 font-heading text-base font-semibold">
            {t.campaigns}
          </h2>
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
          <h2 className="mb-3 font-heading text-base font-semibold">
            {t.unitCosts}
          </h2>
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
