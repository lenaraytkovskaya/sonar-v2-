import { z } from 'zod';
import { PaidHttpError } from './openrouter.js';
const baseFields = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
];
export const contactFields = [
  ...baseFields,
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
];
export const profileSchema = z
  .object({
    id: z.enum(['contacts', 'basic']),
    name: z.string().min(1).max(100),
    fields: z.array(z.enum(contactFields as [string, ...string[]])).min(2),
    priceUsd: z.number().finite().min(0).max(100),
    sku: z.enum(['Text Search Enterprise', 'Text Search Pro']),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!p.fields.includes('places.id') || !p.fields.includes('nextPageToken'))
      ctx.addIssue({ code: 'custom', message: 'Required fields' });
    if (
      p.id === 'contacts' &&
      (!p.fields.includes('places.websiteUri') ||
        p.sku !== 'Text Search Enterprise')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Contacts requires website and Enterprise',
      });
    if (
      p.id === 'basic' &&
      (p.sku !== 'Text Search Pro' ||
        p.fields.some((f) => !baseFields.includes(f)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Basic must use Pro fields only',
      });
  });
export const profilesSchema = z
  .array(profileSchema)
  .length(2)
  .refine((p) => new Set(p.map((v) => v.id)).size === 2);
export type GoogleProfile = z.infer<typeof profileSchema>;
export const googlePageSchema = z.object({
  places: z
    .array(
      z.object({
        id: z.string().min(1),
        displayName: z.object({ text: z.string() }).optional(),
        formattedAddress: z.string().optional(),
        addressComponents: z
          .array(
            z.object({
              longText: z.string(),
              shortText: z.string().optional(),
              types: z.array(z.string()),
            }),
          )
          .optional(),
        location: z
          .object({ latitude: z.number(), longitude: z.number() })
          .optional(),
        types: z.array(z.string()).optional(),
        primaryType: z.string().optional(),
        businessStatus: z.string().optional(),
        googleMapsUri: z.string().optional(),
        websiteUri: z.string().optional(),
        nationalPhoneNumber: z.string().optional(),
        internationalPhoneNumber: z.string().optional(),
        rating: z.number().optional(),
        userRatingCount: z.number().optional(),
      }),
    )
    .max(20)
    .default([]),
  nextPageToken: z.string().optional(),
});
export type GooglePage = z.infer<typeof googlePageSchema>;
export type GoogleSearch = {
  textQuery: string;
  languageCode: string;
  regionCode: string;
  pageSize: 20;
  pageToken?: string;
};
export function normalizeWebsite(
  raw: string | undefined,
): { website: string; domain: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      return null;
    u.hash = '';
    return {
      website: u.href,
      domain: u.hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, ''),
    };
  } catch {
    return null;
  }
}
export function createGoogleClient(key: string, fetcher: typeof fetch = fetch) {
  return async (
    input: GoogleSearch,
    profile: GoogleProfile,
  ): Promise<GooglePage> => {
    if (!key) throw Error('Google key missing');
    const response = await fetcher(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': profile.fields.join(','),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new PaidHttpError(response.status);
    return googlePageSchema.parse(await response.json());
  };
}
