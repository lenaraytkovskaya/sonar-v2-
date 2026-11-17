import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';
import { z } from 'zod';

export type ReplyMatchCompany = {
  id: string;
  website: string | null;
  countryCode: string | null;
  contacts: { kind: string; value: string }[];
};
const domain = (value: string) => {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return null;
  }
};
const emailDomain = (value: string) => {
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return /^[^\s@]+@[^\s@]+$/.test(address.trim())
    ? domain(address.trim().split('@')[1]!)
    : null;
};
const phone = (value: string, country: string | null) => {
  try {
    const parsed = parsePhoneNumberFromString(value, {
      ...(country ? { defaultCountry: country as CountryCode } : {}),
      extract: false,
    });
    return parsed?.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
};
const username = (value: string) => {
  const name = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/$/, '');
  return /^[a-z][a-z0-9_]{3,31}$/i.test(name) ? name.toLowerCase() : null;
};
export type DeterministicReplyMatch = {
  companyId: string;
  kind: 'email_domain' | 'telegram_username' | 'phone';
  value: string;
};
/** A match must identify exactly one company, even if several contacts agree. */
export function deterministicFormReplyMatchEvidence(
  channel: string,
  senders: string[],
  companies: ReplyMatchCompany[],
): DeterministicReplyMatch | null {
  const matches: DeterministicReplyMatch[] = [];
  for (const company of companies)
    for (const sender of senders) {
      if (channel === 'email') {
        const value = emailDomain(sender);
        if (
          value &&
          (domain(company.website ?? '') === value ||
            company.contacts.some(
              (contact) =>
                contact.kind === 'email' &&
                emailDomain(contact.value) === value,
            ))
        )
          matches.push({ companyId: company.id, kind: 'email_domain', value });
      } else if (channel === 'telegram' && username(sender)) {
        const value = username(sender)!;
        if (
          company.contacts.some(
            (contact) =>
              contact.kind === 'telegram' && username(contact.value) === value,
          )
        )
          matches.push({
            companyId: company.id,
            kind: 'telegram_username',
            value,
          });
      } else if (['telegram', 'whatsapp', 'phone'].includes(channel)) {
        const value = phone(sender, company.countryCode);
        if (
          value &&
          company.contacts.some(
            (contact) =>
              ['phone', 'whatsapp', 'telegram'].includes(contact.kind) &&
              phone(contact.value, company.countryCode) === value,
          )
        )
          matches.push({ companyId: company.id, kind: 'phone', value });
      }
    }
  return new Set(matches.map((match) => match.companyId)).size === 1
    ? matches[0]!
    : null;
}
export function deterministicFormReplyMatch(
  channel: string,
  senders: string[],
  companies: ReplyMatchCompany[],
): string | null {
  return (
    deterministicFormReplyMatchEvidence(channel, senders, companies)
      ?.companyId ?? null
  );
}
const modelMatch = z
  .object({
    companyId: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    reasonUk: z.string().trim().min(1).max(1000),
  })
  .strict();
export function parseFormReplyMatch(text: string, candidateIds: string[]) {
  const result = modelMatch.parse(JSON.parse(text));
  if (result.companyId !== null && !candidateIds.includes(result.companyId))
    throw new Error('Unknown reply match candidate');
  return result;
}
