import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'min-h-11 w-full min-w-0 rounded-lg border border-border bg-raised px-3 py-2 text-base',
        className,
      )}
      {...props}
    />
  );
}
