'use client';
import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';

export function FilterPanel({
  count,
  resetHref,
  onReset,
  toolbar,
  children,
}: {
  count: number;
  resetHref?: string;
  onReset?: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(count > 0);
  const id = useId();
  return (
    <div className="mb-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <Button
          variant="outline"
          className="min-h-11"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          {uk.filters.title}
          {count > 0 && (
            <span
              aria-label={`${uk.filters.active}: ${count}`}
              className="rounded-full bg-chip px-1.5 text-xs tabular-nums"
            >
              {count}
            </span>
          )}
        </Button>
        {count > 0 &&
          (resetHref ? (
            <Link
              className="inline-flex min-h-11 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-accent"
              href={resetHref}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {uk.filters.reset}
            </Link>
          ) : (
            onReset && (
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  onReset();
                }}
              >
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {uk.filters.reset}
              </Button>
            )
          ))}
      </div>
      <div
        id={id}
        hidden={!open}
        className="mt-3 rounded-xl border border-border bg-surface p-3"
      >
        {children}
      </div>
    </div>
  );
}
