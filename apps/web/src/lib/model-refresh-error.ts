import { uk } from '../i18n/uk';

export function modelRefreshError(code?: string, fallback?: string) {
  return (
    uk.ai.modelErrors[code as keyof typeof uk.ai.modelErrors] ??
    fallback ??
    uk.ai.error
  );
}
