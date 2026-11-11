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
