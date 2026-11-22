import { expect, it } from 'vitest';
import {
  googlePairKey,
  googleSearchPairs,
  plannedGoogleRequests,
} from './google-plan.js';
import { campaignSchema, normalizeCampaignLanguages } from './campaign.js';
const config = {
  queries: ['q1', 'q2'],
  cities: ['c1', 'c2'],
  language_code: 'pl',
};
it('preserves the exact historical query/city index order for legacy snapshots', () => {
  expect(googleSearchPairs(config)).toEqual([
    { query: 'q1', city: 'c1', language: 'pl' },
    { query: 'q1', city: 'c2', language: 'pl' },
    { query: 'q2', city: 'c1', language: 'pl' },
    { query: 'q2', city: 'c2', language: 'pl' },
  ]);
});
it('plans every query x city x language and keeps cursor keys distinct', () => {
  const pairs = googleSearchPairs({ ...config, language_codes: ['uk', 'en'] });
  expect(pairs).toHaveLength(8);
  expect(
    new Set(pairs.map((p) => googlePairKey(p.query, p.city, p.language))).size,
  ).toBe(8);
  expect(
    plannedGoogleRequests({ ...config, language_codes: ['uk', 'en'] }, {}),
  ).toBe(24);
  expect(
    plannedGoogleRequests(config, {
      [googlePairKey('q1', 'c1', 'pl')]: {
        pages: 2,
        exhausted: false,
        buffer: [],
      },
      [googlePairKey('q1', 'c2', 'pl')]: {
        pages: 1,
        exhausted: true,
        buffer: [],
      },
    }),
  ).toBe(7);
});
it('normalizes fallback and first-language compatibility without borrowing legacy cursors', () => {
  expect(normalizeCampaignLanguages({})).toEqual({
    language_code: 'uk',
    language_codes: ['uk'],
  });
  expect(
    normalizeCampaignLanguages({ language_code: 'pl' }).language_codes,
  ).toEqual(['pl']);
  expect(
    normalizeCampaignLanguages({
      language_code: 'pl',
      language_codes: ['en', 'uk'],
    }).language_code,
  ).toBe('en');
  expect(
    plannedGoogleRequests(
      { queries: ['q'], cities: ['c'], language_codes: ['en'] },
      { '["q","c"]': { pages: 3, exhausted: true, buffer: [] } },
    ),
  ).toBe(3);
});
it.each(
  [[], [''], ['english'], ['uk', 'uk'], ['EN'], Array(21).fill('en')].map(
    (language_codes) => ({ language_codes }),
  ),
)('rejects invalid language arrays %j', ({ language_codes }) => {
  const schema = campaignSchema.pick({ language_codes: true });
  expect(schema.safeParse({ language_codes }).success).toBe(false);
});
