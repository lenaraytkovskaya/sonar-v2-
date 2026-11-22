import { expect, it } from 'vitest';
import { campaignSchema } from './campaign.js';
import {
  campaignDefaultsSchema,
  createCampaignDraft,
  campaignGoogleEstimate,
  parseCampaignChips,
  campaignNumericSuggestion,
  campaignWeightsSuggestion,
  campaignChannelsSuggestion,
} from './campaign-editor.js';
const defaults = {
  country_code: 'PL',
  language_code: 'uk',
  language_codes: ['pl', 'en'],
  cities: ['Warszawa'],
  queries: ['Workshop'],
  batch_size: 50,
  budget_usd: 17.5,
  channels: {
    email: false,
    telegram: false,
    whatsapp: false,
    viber: false,
    forms: true,
  },
  send_mode: 'approval',
  min_score: 73,
};
it('uses complete custom DB defaults and returns independent fresh drafts', () => {
  const weights = { website: 13 };
  const draft = createCampaignDraft(defaults, weights);
  expect(draft).toMatchObject({
    ...defaults,
    language_code: 'pl',
    name: '',
    product_id: null,
    scoring_weights: weights,
  });
  expect(campaignSchema.safeParse({ ...draft, name: 'Ready' }).success).toBe(
    true,
  );
  draft.cities.push('Other');
  draft.language_codes!.push('de');
  draft.channels.forms = false;
  draft.scoring_weights.website = 99;
  expect(createCampaignDraft(defaults, weights).cities).toEqual(['Warszawa']);
  expect(defaults.language_codes).toEqual(['pl', 'en']);
  expect(defaults.channels.forms).toBe(true);
  expect(weights.website).toBe(13);
});
it('never silently replaces missing or invalid DB configuration', () => {
  for (const key of Object.keys(defaults)) {
    const value = { ...defaults };
    delete value[key as keyof typeof value];
    expect(campaignDefaultsSchema.safeParse(value).success).toBe(false);
  }
  expect(() => createCampaignDraft(undefined, {})).toThrow();
  expect(() => createCampaignDraft(defaults, { website: 101 })).toThrow();
});
it('uses current tariff and saved language-scoped progress for conservative costs', () => {
  const config = {
    queries: ['q'],
    cities: ['c'],
    language_codes: ['uk', 'en'],
  };
  expect(campaignGoogleEstimate(config, {}, 0.011)).toEqual({
    requests: 6,
    usd: 0.066,
  });
  expect(
    campaignGoogleEstimate(
      config,
      { '["q","c","uk"]': { pages: 2, exhausted: false, buffer: [] } },
      0.023,
    ),
  ).toEqual({ requests: 4, usd: 0.092 });
  expect(() => campaignGoogleEstimate(config, {}, NaN)).toThrow();
});
it('normalizes multiline chip suggestions and rejects invalid lists', () => {
  expect(parseCampaignChips(' • Київ\n\n- Львів\n Київ ', 'cities')).toEqual([
    'Київ',
    'Львів',
  ]);
  expect(parseCampaignChips('uk\nen\nuk', 'language_codes')).toEqual([
    'uk',
    'en',
  ]);
  for (const text of ['english', 'EN', ''])
    expect(() => parseCampaignChips(text, 'language_codes')).toThrow();
  expect(() =>
    parseCampaignChips(
      Array.from({ length: 101 }, (_, n) => `q${n}`).join('\n'),
      'queries',
    ),
  ).toThrow();
});
it('bounds numeric and structured AI suggestions without changing config keys', () => {
  expect(campaignNumericSuggestion(' 12.5 ', 'budget_usd')).toBe(12.5);
  for (const text of ['', 'NaN', 'Infinity', '-1', '100001'])
    expect(() => campaignNumericSuggestion(text, 'budget_usd')).toThrow();
  expect(() => campaignNumericSuggestion('101', 'min_score')).toThrow();
  expect(() => campaignNumericSuggestion('21', 'batch_size')).toThrow();
  expect(() => campaignNumericSuggestion('3.5', 'weight')).toThrow();
  expect(campaignWeightsSuggestion('{"website":4}', ['website'])).toEqual({
    website: 4,
  });
  expect(() => campaignWeightsSuggestion('{"other":4}', ['website'])).toThrow();
  expect(campaignChannelsSuggestion(JSON.stringify(defaults.channels))).toEqual(
    defaults.channels,
  );
  expect(() => campaignChannelsSuggestion('{"email":true}')).toThrow();
  expect(() =>
    campaignChannelsSuggestion(
      JSON.stringify({ ...defaults.channels, unknown: true }),
    ),
  ).toThrow();
});
it('accepts only an exact eligible product choice and rejects invented or ambiguous names', async () => {
  const { campaignProductSuggestion } = await import('./campaign-editor.js');
  const active = { id: 'active-id', name: 'Active', status: 'active' as const };
  const archived = {
    id: 'archive-id',
    name: 'Archived',
    status: 'archived' as const,
  };
  const products = [active, archived];
  expect(campaignProductSuggestion('Active', products)).toBe(active.id);
  expect(campaignProductSuggestion(active.id, products)).toBe(active.id);
  expect(campaignProductSuggestion('Archived', products, archived.id)).toBe(
    archived.id,
  );
  for (const value of ['Invented', 'Archived', archived.id, ''])
    expect(() => campaignProductSuggestion(value, products)).toThrow();
  expect(() =>
    campaignProductSuggestion('Active', [
      ...products,
      { ...active, id: 'other-id' },
    ]),
  ).toThrow();
});
