'use client';
import { useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { cn } from '@/lib/utils';
import { Button } from './button';
export function RevealToggle({
  visible,
  onToggle,
  disabled = false,
}: {
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const label = visible ? uk.actions.hide : uk.actions.show;
  return (
    <Button
      type="button"
      variant="ghost"
      className="size-11 shrink-0 p-2"
      title={label}
      aria-label={label}
      aria-pressed={visible}
      disabled={disabled}
      onClick={onToggle}
    >
      {visible ? (
        <EyeOff aria-hidden="true" className="size-4" />
      ) : (
        <Eye aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
}
/** Only non-secret values belong here. Input secrets use RevealToggle before saving. */
export function RevealValue({
  value,
  masked = '••••',
  copy = false,
  href,
  className,
}: {
  value: string;
  masked?: string;
  copy?: boolean;
  href?: string;
  className?: string;
}) {
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const visible = revealedValue === value;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full flex-wrap items-center',
        className,
      )}
    >
      {visible && href ? (
        <a
          href={href}
          target={/^https?:/.test(href) ? '_blank' : undefined}
          rel="noreferrer"
          className="min-w-0 break-all text-accent"
        >
          {value}
        </a>
      ) : (
        <span className="min-w-0 break-all">{visible ? value : masked}</span>
      )}
      <RevealToggle
        visible={visible}
        onToggle={() => {
          setRevealedValue(visible ? null : value);
          setNotice('');
        }}
      />
      {copy && visible && (
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-2"
          title={uk.actions.copy}
          aria-label={uk.actions.copy}
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => setNotice(uk.outreach.copied))
              .catch(() => setNotice(uk.email.error))
          }
        >
          <Copy aria-hidden="true" className="size-4" />
        </Button>
      )}
      {notice && (
        <span role="status" className="text-xs text-muted-foreground">
          {notice}
        </span>
      )}
    </span>
  );
}
