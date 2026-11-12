import { normalizePhone, type CountryCode } from './index.js';

/** Canonical form of a recipient so an allowlist entry matches however the contact was written. */
export function recipientKey(raw: string, country?: CountryCode): string {
  const value = raw.trim().toLowerCase();
  const tme = value.match(
    /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/@?([a-z0-9_]{4,})\/?$/,
  );
  if (tme) return '@' + tme[1];
  if (/^@[a-z0-9_]{4,}$/.test(value)) return value;
  const wa = value.match(/^(?:https?:\/\/)?wa\.me\/(\d+)\/?$/);
  if (wa) return '+' + wa[1];
  if (value.startsWith('mailto:')) return value.slice(7);
  if (value.includes('@')) return value;
  if (/^[+\d][\d\s().-]{5,}$/.test(value)) {
    const phone = value.startsWith('+')
      ? normalizePhone(value, country ?? 'UA')
      : country
        ? normalizePhone(value, country)
        : null;
    if (phone) return phone;
  }
  try {
    const url = new URL(
      /^https?:\/\//.test(value) ? value : 'https://' + value,
    );
    return url.hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

export const testModeReason =
  'Тестовий режим: отримувача немає у списку дозволених контактів.';

/** In test mode only recipients from the owner's list may be contacted. */
export function testModeAllows(
  to: string,
  allowlist: string[],
  country?: CountryCode,
): boolean {
  const key = recipientKey(to, country);
  return allowlist.some((entry) => recipientKey(entry, country) === key);
}
