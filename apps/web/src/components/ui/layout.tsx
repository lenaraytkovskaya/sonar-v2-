'use client';
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { uk } from '@/i18n/uk';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/** A titled block of a page (docs/DESIGN.md §3): header row with an optional action, then content. */
export function Section({
  id,
  title,
  description,
  actions,
  className,
  children,
}: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        'rounded-xl border border-border bg-surface shadow-xs',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-1">
            {title && (
              <h2 className="font-heading text-base font-semibold">{title}</h2>
            )}
            {description && (
              <p className="max-w-prose text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** Label → value pairs, two columns on wide screens (DESIGN.md §4). */
export function DetailList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; hidden?: boolean }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3',
        className,
      )}
    >
      {items
        .filter((item) => !item.hidden)
        .map((item, index) => (
          <div key={index} className="min-w-0 space-y-0.5">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">
              {item.value}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** Long explanations live behind an ⓘ instead of filling the page (DESIGN.md §5). */
export function InfoTip({
  children,
  label = uk.more,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-chip hover:text-foreground"
      >
        <Info aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 text-sm leading-6 text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A short coloured note under a block: warnings and errors, one or two lines. */
export function Callout({
  tone = 'wait',
  children,
}: {
  tone?: 'wait' | 'err' | 'ok' | 'run';
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2 text-sm',
        {
          wait: 'bg-wait-bg text-wait',
          err: 'bg-err-bg text-err',
          ok: 'bg-ok-bg text-ok',
          run: 'bg-run-bg text-run',
        }[tone],
      )}
    >
      {children}
    </p>
  );
}
