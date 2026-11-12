import { z } from 'zod';
import { getCountries } from 'libphonenumber-js/max';
const text = z.string().trim().min(1).max(200);
const country = z
  .string()
  .refine((v) =>
    getCountries().includes(v as ReturnType<typeof getCountries>[number]),
  );
export const campaignSchema = z
  .object({
    name: text,
    country_code: country,
    language_code: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
    cities: z.array(text).max(100),
    queries: z.array(text).max(100),
    offer: z.string().max(20000),
    batch_size: z.union([
      z.literal(20),
      z.literal(50),
      z.literal(100),
      z.literal(200),
    ]),
    budget_usd: z.number().finite().min(0).max(100000),
    channels: z
      .object({
        email: z.boolean(),
        telegram: z.boolean(),
        whatsapp: z.boolean(),
        forms: z.boolean(),
      })
      .strict(),
    send_mode: z.enum(['auto', 'approval', 'manual']),
    scoring_weights: z.record(
      z.string().min(1).max(80),
      z.number().int().min(0).max(100),
    ),
    field_profile: z.enum(['contacts', 'basic']).default('contacts'),
    status: z.enum(['draft', 'active', 'paused', 'archived']),
  })
  .strict();
export const campaignSuggestionSchema = campaignSchema
  .pick({
    name: true,
    country_code: true,
    language_code: true,
    cities: true,
    queries: true,
    offer: true,
  })
  .extend({
    cities: z.array(text).min(1).max(100),
    queries: z.array(text).min(5).max(20),
    // Older completed tasks do not contain this flag.
    needs_about: z.boolean().default(false),
  })
  .refine((v) => !v.needs_about || v.offer === '', {
    path: ['offer'],
    message: 'An offer requires company.about',
  });
export type CampaignInput = z.infer<typeof campaignSchema>;
export type CampaignSuggestion = z.infer<typeof campaignSuggestionSchema>;
export function parseCampaignSuggestion(raw: string) {
  return campaignSuggestionSchema.parse(JSON.parse(raw));
}

// Conservative, whole-word inflections: never match arbitrary city-name prefixes.
function cityWordPattern(word: string): string {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^ки[їє]в$/iu.test(word))
    return 'ки[їє]в(?:а|у|і|ом|ськ(?:ий|а|е|і|ої|ій|ого|ому|их|ими))?';
  if (!/^[а-яіїєґ]{4,}$/iu.test(word)) return escape(word);
  if (/(?:ий|ій)$/iu.test(word))
    return (
      escape(word.slice(0, -2)) + '(?:ий|ій|ого|ому|им|ім|а|ої|у|е|і|их|ими)'
    );
  if (/[ая]$/iu.test(word))
    return escape(word.slice(0, -1)) + '(?:а|я|и|і|ї|у|ю|ою|ею|ої|ій)';
  if (/[иі]$/iu.test(word))
    return (
      escape(word.slice(0, -1)) +
      '(?:и|і|ів|ам|ах|ами|ськ(?:ий|а|е|і|ої|ій|ого|ому|их|ими))'
    );
  const stem = escape(word.replace(/ь$/u, ''));
  return stem + '(?:ь|а|я|у|ю|і|ем|ом|ськ(?:ий|а|е|і|ої|ій|ого|ому|их|ими))?';
}

export function cleanCampaignQueries(
  queries: string[],
  cities: string[],
): string[] {
  const patterns = cities
    .filter((city) => city.trim())
    .map((city) => {
      const name = city
        .trim()
        .split(/[\s-]+/u)
        .map(cityWordPattern)
        .join('[\\s-]+');
      return new RegExp(
        `(?<![\\p{L}\\p{N}])(?:(?:у|в|із|зі|з|по|місто|м\\.)\\s+)?${name}(?:\\s+(?:област[ьі]|регіон[уі]?))?(?![\\p{L}\\p{N}])`,
        'giu',
      );
    });
  const seen = new Set<string>();
  return queries
    .map((query) => {
      const original = query;
      for (const pattern of patterns) query = query.replace(pattern, ' ');
      if (query !== original)
        query = query.replace(
          /(?:^\s*(?:і|й|та|and)(?!\p{L})|(?<!\p{L})(?:і|й|та|and)\s*$)/giu,
          '',
        );
      return query
        .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/gu, '')
        .replace(/\s+/gu, ' ');
    })
    .filter((query) => {
      const key = query.toLocaleLowerCase();
      if (!query || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function applyCampaignSuggestion(
  form: CampaignInput,
  suggestion: CampaignSuggestion,
): CampaignInput {
  const { needs_about, ...fields } = suggestion;
  return {
    ...form,
    ...fields,
    // An empty suggested offer never wipes a message the person already wrote.
    offer: !needs_about && fields.offer.trim() ? fields.offer : form.offer,
    queries: cleanCampaignQueries(fields.queries, fields.cities),
  };
}
