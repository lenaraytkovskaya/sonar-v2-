import { z } from 'zod';
import {
  campaignSchema,
  normalizeCampaignLanguages,
  type CampaignInput,
} from './campaign.js';
import { profileSchema } from './google.js';
import {
  plannedGoogleRequests,
  type GooglePlanConfig,
  type GoogleProgress,
} from './google-plan.js';

export const campaignDefaultsSchema = campaignSchema
  .pick({
    country_code: true,
    language_code: true,
    language_codes: true,
    cities: true,
    queries: true,
    batch_size: true,
    budget_usd: true,
    channels: true,
    send_mode: true,
    min_score: true,
  })
  .extend({
    language_code: campaignSchema.shape.language_code.unwrap(),
    language_codes: campaignSchema.shape.language_codes.unwrap(),
    send_mode: campaignSchema.shape.send_mode.unwrap(),
    min_score: campaignSchema.shape.min_score.unwrap(),
    channels: campaignSchema.shape.channels.extend({ viber: z.boolean() }),
  });
export type CampaignDefaults = z.infer<typeof campaignDefaultsSchema>;
export function createCampaignDraft(
  defaults: unknown,
  weights: unknown,
): CampaignInput {
  return {
    ...normalizeCampaignLanguages(campaignDefaultsSchema.parse(defaults)),
    scoring_weights: campaignSchema.shape.scoring_weights.parse(weights),
    name: '',
    product_id: null,
    status: 'draft',
    field_profile: 'contacts',
    offer: '',
    outreach_goal: '',
  };
}
export function campaignGoogleEstimate(
  config: GooglePlanConfig,
  progress: GoogleProgress,
  priceUsd: unknown,
) {
  const requests = plannedGoogleRequests(config, progress);
  const price = profileSchema.shape.priceUsd.parse(priceUsd);
  return { requests, usd: Number((requests * price).toFixed(10)) };
}
export function parseCampaignChips(
  text: string,
  kind: 'cities' | 'queries' | 'language_codes',
) {
  const values = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((value) => value.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/u, ''))
        .filter(Boolean),
    ),
  ];
  return (
    kind === 'language_codes'
      ? campaignSchema.shape.language_codes.unwrap()
      : campaignSchema.shape[kind]
  ).parse(values);
}
export function campaignNumericSuggestion(
  text: string,
  key: 'batch_size' | 'budget_usd' | 'min_score' | 'weight',
): number {
  if (!text.trim()) throw Error('Empty numeric suggestion');
  const value = Number(text.trim());
  return key === 'weight'
    ? campaignSchema.shape.scoring_weights.parse({ value }).value!
    : campaignSchema.shape[key].parse(value);
}
export function campaignWeightsSuggestion(text: string, keys: string[]) {
  const values = campaignSchema.shape.scoring_weights.parse(JSON.parse(text));
  if (Object.keys(values).sort().join('\0') !== [...keys].sort().join('\0'))
    throw Error('Scoring keys changed');
  return values;
}
export const campaignChannelsSuggestion = (text: string) =>
  campaignDefaultsSchema.shape.channels.parse(JSON.parse(text));
export function campaignProductSuggestion(
  text: string,
  products: { id: string; name: string; status: 'active' | 'archived' }[],
  selectedId?: string | null,
) {
  const value = text.trim();
  const eligible = products.filter(
    (product) => product.status === 'active' || product.id === selectedId,
  );
  const exactId = eligible.find((product) => product.id === value);
  if (exactId) return exactId.id;
  const names = eligible.filter((product) => product.name === value);
  if (names.length !== 1) throw Error('Select an existing eligible product');
  return names[0]!.id;
}
