import { expect, it } from 'vitest';
import {
  normalizedRating,
  scoreCompany,
  scoringFeatures,
  type ScoringContact,
  type ScoringInput,
} from './scoring.js';

const empty: ScoringInput = {
  website: null,
  siteScanDone: false,
  rating: null,
  ratingsCount: null,
  registryFound: false,
  registryTerminated: false,
  contacts: [],
};
const contact = (
  kind: ScoringContact['kind'],
  value: string,
  changes: Partial<ScoringContact> = {},
): ScoringContact => ({
  id: value,
  kind,
  value,
  normalized: value,
  source: 'website',
  source_url: 'https://shop.example.com',
  rank: 50,
  found_at: '2026-11-01T00:00:00Z',
  ...changes,
});
const value = (
  input: ScoringInput,
  feature: (typeof scoringFeatures)[number],
) =>
  scoreCompany(input, { [feature]: 1 }).breakdown.features.find(
    (row) => row.feature === feature,
  )!.value;

it('calculates a normalized weighted sum with explanatory contributions and recalculates changed weights', () => {
  const input = {
    ...empty,
    website: 'https://shop.example.com',
    siteScanDone: true,
  };
  const first = scoreCompany(input, { website: 3, phone: 1 });
  expect(first.score).toBe(75);
  expect(first.breakdown.features[0]).toEqual({
    feature: 'website',
    value: 1,
    weight: 3,
    contribution: 75,
  });
  expect(scoreCompany(input, { website: 1, phone: 3 }).score).toBe(25);
  expect(scoreCompany(input, {}).score).toBe(0);
  expect(scoreCompany(input, { website: -10, phone: NaN }).score).toBe(0);
  expect(
    scoreCompany(
      empty,
      Object.fromEntries(scoringFeatures.map((feature) => [feature, 1])),
    ).score,
  ).toBe(0);
});

it('normalizes rating logarithmically and keeps missing, negative and extreme values bounded', () => {
  expect(normalizedRating(5, 1000)).toBe(1);
  expect(normalizedRating(2.5, 1000)).toBe(0.5);
  expect(normalizedRating(5, 9)).toBeCloseTo(Math.log(10) / Math.log(1001));
  expect(normalizedRating(5, 10_000)).toBe(1);
  for (const [rating, reviews] of [
    [null, null],
    [5, 0],
    [5, -1],
    [-5, 10],
    [NaN, 10],
    [5, NaN],
  ])
    expect(normalizedRating(rating!, reviews!)).toBe(0);
});

it('requires a completed website scan, rewards matching email domains and excludes terminated registry entities', () => {
  const input = { ...empty, website: 'https://www.example.co.uk' };
  expect(value(input, 'website')).toBe(0);
  expect(value({ ...input, siteScanDone: true }, 'website')).toBe(1);
  expect(
    value(
      { ...input, contacts: [contact('email', 'hello@mail.example.co.uk')] },
      'email',
    ),
  ).toBe(1);
  expect(
    value(
      { ...input, contacts: [contact('email', 'hello@gmail.com')] },
      'email',
    ),
  ).toBe(0.5);
  expect(
    value(
      {
        ...input,
        contacts: [contact('email', 'hello@example.co.uk.evil.org')],
      },
      'email',
    ),
  ).toBe(0.5);
  expect(value({ ...empty, registryFound: true }, 'registry')).toBe(1);
  expect(
    value(
      { ...empty, registryFound: true, registryTerminated: true },
      'registry',
    ),
  ).toBe(0);
});

it('counts distinct channel categories and bounds a fully populated company at 100', () => {
  const contacts = [
    contact('email', 'hello@example.com'),
    contact('phone', '+380671234567'),
    contact('telegram', 'https://t.me/shop'),
    contact('whatsapp', 'https://wa.me/380671234567'),
    contact('viber', 'viber://chat?number=380671234567'),
    contact('form', 'https://example.com/contact'),
    contact('social', 'https://facebook.com/shop'),
  ];
  const input = {
    ...empty,
    website: 'https://example.com',
    siteScanDone: true,
    rating: 5,
    ratingsCount: 1000,
    registryFound: true,
    contacts,
  };
  expect(value(input, 'reachability')).toBe(1);
  expect(
    value(
      {
        ...empty,
        contacts: contacts.filter((c) =>
          ['telegram', 'whatsapp', 'viber'].includes(c.kind),
        ),
      },
      'reachability',
    ),
  ).toBe(0.2);
  expect(
    scoreCompany(
      input,
      Object.fromEntries(scoringFeatures.map((feature) => [feature, 1])),
    ).score,
  ).toBe(100);
});

it('selects top contacts by rank, mobile suitability, source and freshness without mutating input', () => {
  const contacts = [
    contact('phone', '+380441234567'),
    contact('phone', '+380671234567'),
    contact('email', 'older@example.com'),
    contact('email', 'newer@example.com', { found_at: '2026-11-02T00:00:00Z' }),
    contact('email', 'google@example.com', {
      source: 'google',
      found_at: '2026-11-03T00:00:00Z',
    }),
    contact('telegram', 'https://t.me/low'),
    contact('whatsapp', 'https://wa.me/380671234567', { rank: 70 }),
    contact('social', 'https://facebook.com/shop'),
    contact('form', 'https://example.com/contact'),
  ];
  const before = structuredClone(contacts);
  const top = scoreCompany({ ...empty, contacts }, {}).breakdown.top;
  expect(top.phone?.value).toBe('+380671234567');
  expect(top.email?.value).toBe('newer@example.com');
  expect(top.messenger?.kind).toBe('whatsapp');
  expect(top.form?.kind).toBe('form');
  expect(top.social?.kind).toBe('social');
  expect(contacts).toEqual(before);
  const registry = contact('email', 'registry@example.com', {
    source: 'registry',
  });
  const google = contact('email', 'google@example.com', { source: 'google' });
  expect(
    scoreCompany({ ...empty, contacts: [google, registry] }, {}).breakdown.top
      .email?.source,
  ).toBe('registry');
  expect(
    scoreCompany(
      { ...empty, contacts: [registry, { ...google, rank: 100 }] },
      {},
    ).breakdown.top.email?.source,
  ).toBe('google');
});
