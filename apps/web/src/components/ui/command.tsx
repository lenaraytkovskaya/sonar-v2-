'use client';
import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-lg bg-surface text-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <CommandPrimitive.Input
        className={cn(
          'min-h-11 w-full min-w-0 bg-transparent py-3 text-base outline-none placeholder:text-muted-foreground',
          className,
        )}
        {...props}
      />
    </div>
  );
}
export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn(
        'max-h-72 overflow-x-hidden overflow-y-auto p-1',
        className,
      )}
      {...props}
    />
  );
}
export function CommandEmpty(
  props: React.ComponentProps<typeof CommandPrimitive.Empty>,
) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-sm text-muted-foreground"
      {...props}
    />
  );
}
export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none select-none data-[selected=true]:bg-chip data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
