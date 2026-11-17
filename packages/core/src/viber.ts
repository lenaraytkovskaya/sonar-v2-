import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';

export function normalizeViberRecipient(
  value: string,
  defaultCountry?: string,
) {
  const phone = parsePhoneNumberFromString(value, {
    defaultCountry: defaultCountry as CountryCode | undefined,
    extract: false,
  });
  return phone?.isValid() ? phone.number : null;
}

export function viberChatUrl(to: string, text: string) {
  const normalized = normalizeViberRecipient(to);
  if (!normalized || normalized !== to || !text.trim())
    throw new Error('Invalid Viber chat URL input');
  const query = new URLSearchParams({
    number: normalized.slice(1),
    draft: text,
  });
  return `viber://chat?${query.toString()}`;
}

export function parseViberChatUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'viber:' || url.hostname !== 'chat' || url.pathname)
    throw new Error('Invalid Viber chat URL');
  const number = url.searchParams.get('number') ?? '';
  const to = normalizeViberRecipient(`+${number}`);
  const text = url.searchParams.get('draft') ?? '';
  if (!to || to.slice(1) !== number || !text.trim())
    throw new Error('Invalid Viber chat URL');
  return { to, text };
}
