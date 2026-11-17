'use client';
import { uk } from '@/i18n/uk';
import { presentError } from '@/lib/error-display';
import { InfoTip } from './ui/layout';

export function FriendlyError({
  reason,
  className,
}: {
  reason: string;
  className?: string;
}) {
  const error = presentError(reason);
  return (
    <span className={className}>
      {error.message}
      {error.details && (
        <InfoTip label={uk.errors.technicalDetails}>{error.details}</InfoTip>
      )}
    </span>
  );
}
