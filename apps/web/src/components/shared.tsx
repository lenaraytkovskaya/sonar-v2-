import type { ReactNode } from 'react';
import { uk } from '@/i18n/uk';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
export { Card } from '@/components/ui/card';
/** Score bands: 70+ strong lead, 40–70 worth a look, below 40 weak. */
export function scoreTone(value: number | null) {
  if (value === null) return { text: 'text-muted-foreground', bar: 'bg-chip' };
  if (value >= 70) return { text: 'text-ok', bar: 'bg-ok' };
  if (value >= 40) return { text: 'text-wait', bar: 'bg-wait' };
  return { text: 'text-err', bar: 'bg-err' };
}
export function Score({
  value,
  compact = false,
}: {
  value: number | null;
  compact?: boolean;
}) {
  const tone = scoreTone(value);
  return value === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <div className={cn('space-y-1', compact ? 'w-16' : 'min-w-24')}>
      <span className={cn('font-semibold tabular-nums', tone.text)}>
        {value.toFixed(1)}
      </span>
      <div
        role="progressbar"
        aria-label={uk.company.score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-chip"
      >
        <div
          className={cn('h-full rounded-full', tone.bar)}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
const companyTones: Record<keyof typeof uk.company.statuses, string> = {
  new: 'bg-idle-bg text-idle',
  enriching: 'bg-run-bg text-run',
  ready: 'bg-run-bg text-run',
  contacted: 'bg-wait-bg text-wait',
  replied: 'bg-ok-bg text-ok',
  interested: 'bg-ok-bg text-ok',
  deal: 'bg-ok-bg text-ok',
  refused: 'bg-err-bg text-err',
  do_not_contact: 'bg-err-bg text-err',
};
export function CompanyStatus({
  status,
}: {
  status: keyof typeof uk.company.statuses;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        companyTones[status],
      )}
    >
      {uk.company.statuses[status]}
    </span>
  );
}
export function StatusPill({ status }: { status: keyof typeof uk.status }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2.5 py-1 text-xs font-medium',
        {
          ok: 'bg-ok-bg text-ok',
          run: 'bg-run-bg text-run',
          wait: 'bg-wait-bg text-wait',
          err: 'bg-err-bg text-err',
          idle: 'bg-idle-bg text-idle',
        }[status],
      )}
    >
      {uk.status[status]}
    </span>
  );
}
export function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="mb-5">
      <h1 className="font-heading text-2xl font-bold tracking-tight">
        {title}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {description}
      </p>
    </header>
  );
}
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
      <div
        aria-hidden="true"
        className="mb-5 rounded-xl bg-raised p-4 text-accent"
      >
        {icon}
      </div>
      <h2 className="font-heading text-lg font-bold">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </Card>
  );
}

export type ScanResult = {
  pages?: number;
  contacts?: number;
  aiUsed?: boolean;
  costUsd?: number;
  durationMs?: number;
  aiStatus?: string;
};
export function ScanSummary({ result }: { result: ScanResult | null }) {
  return result ? (
    <span className="block text-sm text-muted-foreground">
      {uk.scanner.pages}: {result.pages ?? 0} · {uk.scanner.contacts}:{' '}
      {result.contacts ?? 0}
      {result.aiUsed !== undefined && (
        <> · {result.aiUsed ? uk.scanner.aiUsed : uk.scanner.aiNotUsed}</>
      )}
      {result.aiStatus &&
        uk.scanner.aiStatuses[
          result.aiStatus as keyof typeof uk.scanner.aiStatuses
        ] && (
          <span>
            {' '}
            ·{' '}
            {
              uk.scanner.aiStatuses[
                result.aiStatus as keyof typeof uk.scanner.aiStatuses
              ]
            }
          </span>
        )}
      {result.costUsd !== undefined && (
        <>
          {' '}
          · {uk.scanner.cost}: {Number(result.costUsd).toFixed(4)}
        </>
      )}
      {result.durationMs !== undefined && (
        <>
          {' '}
          · {uk.scanner.duration}: {(result.durationMs / 1000).toFixed(1)}
        </>
      )}
    </span>
  ) : null;
}
