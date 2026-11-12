import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';
export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode,
): string | null {
  const phone = parsePhoneNumberFromString(raw, {
    defaultCountry,
    extract: false,
  });
  return phone?.isValid() ? phone.number : null;
}

export * from './budget.js';
export * from './openrouter.js';
export * from './campaign.js';
export * from './google.js';

export type { CountryCode } from 'libphonenumber-js/max';
export * from './company.js';

export * from './scanner.js';
export * from './test-mode.js';
export * from './registry.js';
export * from './scoring.js';
export * from './analysis.js';
export * from './email.js';
export * from './manual.js';
export * from './prozorro.js';
export * from './platforms.js';
