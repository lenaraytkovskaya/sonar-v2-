import { getCountries, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';
import { normalizePhone } from './index.js';
import { linkedContact, type SiteContact } from './scanner.js';

export const manualContactSchema = z
  .object({
    kind: z.enum([
      'email',
      'phone',
      'telegram',
      'whatsapp',
      'viber',
      'form',
      'social',
    ]),
    value: z.string().trim().min(1).max(2000),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
const website = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
export const manualCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    website: z
      .union([website, z.literal('')])
      .transform((value) => value || undefined)
      .optional(),
    city: z.string().trim().max(200).optional(),
    countryCode: z
      .string()
      .trim()
      .toUpperCase()
      .refine((value) => getCountries().includes(value as CountryCode))
      .default('UA'),
    campaignId: z.string().uuid(),
  })
  .strict();
export type ManualContactInput = z.infer<typeof manualContactSchema>;
export type ManualCompanyInput = z.input<typeof manualCompanySchema>;

export function normalizeManualContact(
  input: ManualContactInput,
  country: CountryCode,
): SiteContact | null {
  const { kind, value } = manualContactSchema.parse(input);
  if (kind === 'email') {
    const email = value.toLowerCase();
    return z.email().safeParse(email).success
      ? { kind, value: email, rank: 100 }
      : null;
  }
  if (kind === 'phone') {
    const phone = normalizePhone(value, country);
    return phone ? { kind, value: phone, rank: 100 } : null;
  }
  if (kind === 'form') {
    if (!website.safeParse(value).success) return null;
    return { kind, value: new URL(value).href, rank: 70 };
  }
  if (!value.startsWith('viber:') && !website.safeParse(value).success)
    return null;
  const contact = linkedContact(value, 'https://manual.invalid/');
  return contact?.kind === kind ? contact : null;
}
