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
    queries: z.array(text).min(5).max(10),
  });
export type CampaignInput = z.infer<typeof campaignSchema>;
export type CampaignSuggestion = z.infer<typeof campaignSuggestionSchema>;
export function parseCampaignSuggestion(raw: string) {
  return campaignSuggestionSchema.parse(JSON.parse(raw));
}
