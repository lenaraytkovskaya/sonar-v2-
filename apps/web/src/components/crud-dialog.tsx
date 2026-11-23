'use client';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Pencil, Plus, X } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export function CrudButton({
  action = 'add',
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { action?: 'add' | 'edit' }) {
  const Icon = action === 'add' ? Plus : Pencil;
  return (
    <Button
      type="button"
      variant={action === 'add' ? 'default' : 'outline'}
      aria-haspopup="dialog"
      className={cn('min-h-11', className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      {children}
    </Button>
  );
}

export function CrudDialog({
  open,
  onOpenChange,
  title,
  pending = false,
  wide = false,
  draft,
  children,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  pending?: boolean;
  wide?: boolean;
  draft: unknown;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const currentDraft = JSON.stringify(draft);
  const latest = useRef(currentDraft);
  latest.current = currentDraft;
  const baseline = useRef(currentDraft);
  const touched = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnRegion = useRef<Element | null>(null);
  const dirty = () => touched.current || latest.current !== baseline.current;
  const close = () => {
    if (!pending && (!dirty() || window.confirm(uk.crud.discard)))
      onOpenChange(false);
  };
  useEffect(() => {
    if (!open) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending || dirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [open, pending]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Radix handles Escape in capture phase, before the inline helper.
            if (
              event.target instanceof Element &&
              event.target.closest('[data-ai-instruction]')
            )
              event.preventDefault();
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border border-border bg-surface text-foreground shadow-xl',
            wide
              ? 'h-[100dvh] max-h-[100dvh] w-full max-w-none rounded-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-xl'
              : 'max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl rounded-xl',
          )}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
            returnRegion.current =
              returnFocus.current?.closest('[data-slot="card"]');
            baseline.current = latest.current;
            touched.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current?.isConnected
              ? returnFocus.current
              : returnRegion.current?.querySelector<HTMLElement>(
                  'button:not(:disabled)',
                );
            target?.focus();
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4">
            <Dialog.Title className="min-w-0 font-heading text-lg font-bold break-words">
              {title}
            </Dialog.Title>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 min-w-11 shrink-0"
              aria-label={uk.crud.close}
              disabled={pending}
              onClick={close}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <div
            className={cn(
              'min-h-0 overflow-y-auto overscroll-contain p-4',
              wide && 'flex-1',
            )}
          >
            <fieldset
              className="min-w-0 space-y-4"
              disabled={pending}
              aria-busy={pending}
              onInputCapture={() => {
                touched.current = true;
              }}
            >
              {children}
            </fieldset>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border p-4">
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={pending}
              onClick={close}
            >
              {uk.ai.cancel}
            </Button>
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              {actions}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
