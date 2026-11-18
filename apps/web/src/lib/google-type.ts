import { uk } from '../i18n/uk';

export function googleTypeLabel(value: string | null | undefined) {
  if (!value) return value;
  return (
    uk.company.googleTypes[value as keyof typeof uk.company.googleTypes] ??
    value
  );
}
