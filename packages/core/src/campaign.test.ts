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
};
const form = {
  ...suggestion,
  offer: 'Legacy offer',
  outreach_goal: 'Legacy goal',
  product_id: '83d7c52f-6aaa-47b1-aa49-c40d738cc44e',
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
    { product_id: 'invented' },
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

it('reads completed legacy suggestions without exposing sales fields and rejects invented product IDs', () => {
  for (const legacy of [
    { offer: 'Old offer', outreach_goal: 'Old goal', needs_about: false },
    { offer: '', needs_about: true },
  ])
    expect(
      parseCampaignSuggestion(JSON.stringify({ ...suggestion, ...legacy })),
    ).toEqual(suggestion);
  for (const change of [
    { needs_about: 'true' },
    { needs_about: null },
    { product_id: form.product_id },
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
  const unsafeSuggestion = {
    ...suggestion,
    needs_about: true,
    offer: 'Do not apply',
    outreach_goal: 'Do not apply',
    product_id: 'another-product',
    queries: ['СТО Київ', 'сто Києва', 'Київ'],
  };
  const result = applyCampaignSuggestion(input, unsafeSuggestion);
  expect(result.queries).toEqual(['СТО']);
  expect(result.offer).toBe(input.offer);
  expect(campaignSchema.safeParse(result).success).toBe(true);
  expect(result).not.toHaveProperty('needs_about');
  expect(result.outreach_goal).toBe(input.outreach_goal);
  expect(result.product_id).toBe(input.product_id);
  expect(input.offer).toBe('Legacy offer');
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
  expect(filled.outreach_goal).toBe(parsed.outreach_goal);
});
it('accepts only the complete contacts profile for campaigns', () => {
  expect(
    campaignSchema.safeParse({ ...form, field_profile: 'basic' }).success,
  ).toBe(false);
});
it.each([
  { languages: ['uk'], expected: ['pl'] },
  { languages: ['uk', 'en'], expected: ['uk', 'en'] },
])(
  'applies suggested language only without an explicit multi-language choice (%j)',
  ({ languages, expected }) => {
    const input = campaignSchema.parse({ ...form, language_codes: languages });
    const result = applyCampaignSuggestion(input, {
      ...suggestion,
      language_code: 'pl',
    });
    expect(result.language_codes).toEqual(expected);
    expect(result.language_code).toBe(expected[0]);
  },
);
