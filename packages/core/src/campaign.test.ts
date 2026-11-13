import { expect, it } from 'vitest';
import {
  campaignSchema,
  parseCampaignSuggestion,
  cleanCampaignQueries,
  applyCampaignSuggestion,
} from './campaign.js';
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
  expect(parseCampaignSuggestion(JSON.stringify(suggestion))).toEqual({
    ...suggestion,
    needs_about: false,
    outreach_goal: '',
  });
  for (const text of [
    'broken',
    '```json\n{}\n```',
    JSON.stringify({ ...suggestion, queries: ['СТО'] }),
    JSON.stringify({ ...suggestion, cities: [] }),
  ])
    expect(() => parseCampaignSuggestion(text)).toThrow();
});

it('accepts needs_about and legacy suggestions, but rejects inconsistent or malformed flags', () => {
  expect(parseCampaignSuggestion(JSON.stringify(suggestion)).needs_about).toBe(
    false,
  );
  expect(
    parseCampaignSuggestion(
      JSON.stringify({ ...suggestion, offer: '', needs_about: true }),
    ).needs_about,
  ).toBe(true);
  for (const change of [
    { needs_about: 'true' },
    { needs_about: true },
    { needs_about: null },
  ])
    expect(() =>
      parseCampaignSuggestion(JSON.stringify({ ...suggestion, ...change })),
    ).toThrow();
});
it('strips whole city names and case endings, then deduplicates and filters empty queries', () => {
  expect(
    cleanCampaignQueries(
      [
        'СТО Київ',
        'сто КИЄВА',
        'СТО Києва й Київської області',
        'автосервіс Київської області',
        'ремонт авто у Києві',
        'Київ',
        ' — Київ — ',
        'шиномонтаж Біла Церква',
        'шиномонтаж Білої Церкви',
        'сервіс у Броварах',
        'сервіс Броварського',
        'СТО Івано-Франківська',
        'СТО New York',
        'ремонт Київстар',
        'ремонт бориспільських двигунів',
      ],
      ['Київ', 'Біла Церква', 'Бровари', 'Івано-Франківськ', 'New York'],
    ),
  ).toEqual([
    'СТО',
    'автосервіс',
    'ремонт авто',
    'шиномонтаж',
    'сервіс',
    'ремонт Київстар',
    'ремонт бориспільських двигунів',
  ]);
});
it('escapes punctuation, keeps unrelated words and does not match parts of multiword towns', () => {
  expect(
    cleanCampaignQueries(
      [
        'СТО A+B',
        'ремонт AAB',
        'Біла техніка',
        'церква',
        'авто Киянин',
        'СТО A+B',
      ],
      ['A+B', 'Біла Церква', 'Київ'],
    ),
  ).toEqual(['СТО', 'ремонт AAB', 'Біла техніка', 'церква', 'авто Киянин']);
});
it('applies cleaned suggestions without leaking metadata into the strict campaign schema', () => {
  const input = campaignSchema.parse(form);
  const result = applyCampaignSuggestion(input, {
    ...suggestion,
    needs_about: true,
    offer: '',
    queries: ['СТО Київ', 'сто Києва', 'Київ'],
  });
  expect(result.queries).toEqual(['СТО']);
  expect(result.offer).toBe(input.offer);
  expect(campaignSchema.safeParse(result).success).toBe(true);
  expect(result).not.toHaveProperty('needs_about');
  expect(input.offer).toBe(suggestion.offer);
});

it('defaults new campaigns to manual and validates outreach thresholds', () => {
  const { send_mode: _mode, ...input } = form;
  void _mode;
  const parsed = campaignSchema.parse(input);
  expect(parsed.send_mode).toBe('manual');
  expect(parsed.min_score).toBe(40);
  expect(campaignSchema.safeParse({ ...form, min_score: 101 }).success).toBe(
    false,
  );
  const filled = applyCampaignSuggestion(
    parsed,
    parseCampaignSuggestion(
      JSON.stringify({ ...suggestion, outreach_goal: 'Познайомитися' }),
    ),
  );
  expect(filled.outreach_goal).toBe('Познайомитися');
});
