import type { ReactNode } from 'react';
import { uk } from '@/i18n/uk';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
export { Card } from '@/components/ui/card';
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
    <header className="mb-8">
      <h1 className="font-heading text-3xl font-bold tracking-tight">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">{description}</p>
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
