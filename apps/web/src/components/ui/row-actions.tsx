'use client';
import { useState } from 'react';
import {
  Ban,
  EyeOff,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Power,
  RotateCcw,
  Trash2,
  Unplug,
  RefreshCw,
} from 'lucide-react';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
const icons = {
  edit: Pencil,
  delete: Trash2,
  enable: Play,
  disable: Power,
  disconnect: Unplug,
  restart: RotateCcw,
  retry: RotateCcw,
  hide: EyeOff,
  block: Ban,
  pause: Pause,
  score: RefreshCw,
};
export type RowAction = {
  kind: keyof typeof icons;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  confirm?: string;
  separator?: boolean;
};
export function RowActions({
  actions,
  label = uk.actions.more,
  disabled = false,
}: {
  actions: RowAction[];
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!actions.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-2"
          aria-label={label}
          aria-haspopup="menu"
          title={label}
          disabled={disabled}
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 p-1"
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ),
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === 'ArrowDown'
              ? (index + 1) % items.length
              : event.key === 'ArrowUp'
                ? (index - 1 + items.length) % items.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : -1;
          if (next >= 0) {
            event.preventDefault();
            items[next]?.focus();
          }
        }}
      >
        {actions.map((action, index) => {
          const Icon = icons[action.kind];
          return (
            <div key={action.kind + index}>
              {index > 0 && (action.separator || action.danger) && (
                <div role="separator" className="my-1 border-t border-border" />
              )}
              <button
                type="button"
                role="menuitem"
                disabled={action.disabled || disabled}
                className={cn(
                  'flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-chip focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50',
                  action.danger && 'text-err',
                )}
                onClick={() => {
                  if (
                    (action.confirm || action.danger) &&
                    !window.confirm(
                      action.confirm ?? uk.actions.confirm(action.label),
                    )
                  )
                    return;
                  setOpen(false);
                  action.onSelect();
                }}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {action.label}
              </button>
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
