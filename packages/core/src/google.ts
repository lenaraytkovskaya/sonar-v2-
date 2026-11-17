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
  'places.primaryTypeDisplayName',
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
const googlePlaceSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional().catch(undefined),
  formattedAddress: z.string().optional().catch(undefined),
  addressComponents: z
    .array(z.unknown())
    .transform((components) =>
      components.flatMap((component) => {
        const parsed = z
          .object({
            longText: z.string().optional(),
            shortText: z.string().optional(),
            languageCode: z.string().optional(),
            types: z.array(z.string()).optional().default([]),
          })
          .safeParse(component);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .optional()
    .catch(undefined),
  location: z
    .object({ latitude: z.number(), longitude: z.number() })
    .optional()
    .catch(undefined),
  types: z.array(z.string()).optional().catch(undefined),
  primaryType: z.string().optional().catch(undefined),
  primaryTypeDisplayName: z
    .object({ text: z.string(), languageCode: z.string().optional() })
    .optional()
    .catch(undefined),
  businessStatus: z.string().optional().catch(undefined),
  googleMapsUri: z.string().optional().catch(undefined),
  websiteUri: z.string().optional().catch(undefined),
  nationalPhoneNumber: z.string().optional().catch(undefined),
  internationalPhoneNumber: z.string().optional().catch(undefined),
  rating: z.number().optional().catch(undefined),
  userRatingCount: z.number().optional().catch(undefined),
});
export const googlePageSchema = z.object({
  places: z
    .array(z.unknown())
    .max(20)
    .default([])
    .transform((places) =>
      places.flatMap((place) => {
        const parsed = googlePlaceSchema.safeParse(place);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
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
// Match locality aliases against the campaign city without replacing a different city.
export function googleCity(
  components: GooglePage['places'][number]['addressComponents'],
  campaignCity: string,
  languageCode: string,
): string {
  const localities =
    components?.filter((c) => c.types.includes('locality')) ?? [];
  const locality =
    localities.find(
      (c) => c.languageCode?.split('-')[0] === languageCode.split('-')[0],
    ) ?? localities[0];
  const value = locality?.longText?.trim();
  if (!value) return campaignCity;
  const letters: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'h',
    ґ: 'g',
    д: 'd',
    е: 'e',
    є: 'ie',
    ж: 'zh',
    з: 'z',
    и: 'y',
    і: 'i',
    ї: 'i',
    й: 'i',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ь: '',
    ю: 'iu',
    я: 'ia',
  };
  const key = (city: string) =>
    city
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[а-яіїєґ]/gu, (letter) => letters[letter] ?? letter)
      .replace(/[^\p{L}\d]/gu, '');
  return key(value) === key(campaignCity) ? campaignCity : value;
}
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

// Keep the paid response as raw text so callers can persist its receipt before parsing.
export function createGoogleClientRaw(
  key: string,
  fetcher: typeof fetch = fetch,
) {
  return async (
    input: GoogleSearch,
    profile: GoogleProfile,
  ): Promise<string> => {
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
    return response.text();
  };
}

// Resolution API returns one entity per input URL, including empty entities on failure.
export const googleMapsResolutionSchema = z
  .object({
    entities: z
      .array(
        z
          .object({
            place: z
              .string()
              .max(2048)
              .regex(/^places\/[A-Za-z0-9_-]+$/)
              .optional(),
          })
          .strict(),
      )
      .length(1),
    failedRequests: z
      .record(z.string(), z.object({ code: z.number().int() }).passthrough())
      .optional(),
    saveToMapsUrl: z.string().optional(),
  })
  .strict();
