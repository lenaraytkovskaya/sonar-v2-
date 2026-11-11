import { expect, it } from 'vitest';
import { campaignSchema, parseCampaignSuggestion } from './campaign.js';
const suggestion = {
  name: 'Авто',
  country_code: 'UA',
  language_code: 'uk',
  cities: ['Київ'],
  queries: [
    'СТО',
    'автосервіс',
    'ремонт авто',
    'шиномонтаж',
    'діагностика авто',
  ],
  offer: 'Доброго дня',
};
const form = {
  ...suggestion,
  batch_size: 20,
  budget_usd: 0.5,
  channels: { email: true, telegram: false, whatsapp: false, forms: false },
  send_mode: 'approval',
  scoring_weights: { website: 30 },
  status: 'draft',
};
it('validates form limits, real ISO country and supported batch sizes', () => {
  expect(campaignSchema.safeParse(form).success).toBe(true);
  for (const change of [
    { country_code: 'ZZ' },
    { batch_size: 21 },
    { budget_usd: -1 },
    { budget_usd: NaN },
    { scoring_weights: { website: 101 } },
    { name: '' },
  ])
    expect(campaignSchema.safeParse({ ...form, ...change }).success).toBe(
      false,
    );
});
it('accepts structured AI JSON and rejects prose, markdown and incomplete suggestions', () => {
  expect(parseCampaignSuggestion(JSON.stringify(suggestion))).toEqual(
    suggestion,
  );
  for (const text of [
    'broken',
    '```json\n{}\n```',
    JSON.stringify({ ...suggestion, queries: ['СТО'] }),
    JSON.stringify({ ...suggestion, cities: [] }),
  ])
    expect(() => parseCampaignSuggestion(text)).toThrow();
});
