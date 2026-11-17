import { expect, it, vi } from 'vitest';
import {
  createGoogleClient,
  createGoogleClientRaw,
  googlePageSchema,
  normalizeWebsite,
  profileSchema,
  profilesSchema,
} from './google.js';
const profile = {
  id: 'contacts' as const,
  name: 'Contacts',
  fields: ['places.id', 'places.websiteUri', 'nextPageToken'],
  priceUsd: 0.035,
  sku: 'Text Search Enterprise' as const,
};
it('uses POST, explicit field mask and exact pagination input', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ places: [{ id: 'abc' }], nextPageToken: 'next' }),
  );
  const client = createGoogleClient('stub-key', fetcher);
  const input = {
    textQuery: 'СТО Київ',
    languageCode: 'uk',
    regionCode: 'UA',
    pageSize: 20 as const,
    pageToken: 'page2',
  };
  expect(await client(input, profile)).toMatchObject({ nextPageToken: 'next' });
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(request.method).toBe('POST');
  expect(request.headers).toMatchObject({
    'X-Goog-Api-Key': 'stub-key',
    'X-Goog-FieldMask': 'places.id,places.websiteUri,nextPageToken',
  });
  expect(JSON.parse(request.body as string)).toEqual(input);
});
it('keeps places when address components have missing or malformed fields', () => {
  const page = googlePageSchema.parse({
    places: [
      {
        id: 'abc',
        addressComponents: [
          { longText: 'Kyiv', languageCode: 'uk' },
          { longText: 'Ukraine', shortText: 'UA', types: ['country'] },
          null,
          { longText: 42, types: 'locality' },
        ],
      },
    ],
  });
  expect(page.places).toHaveLength(1);
  expect(page.places[0]?.addressComponents).toEqual([
    { longText: 'Kyiv', types: [] },
    { longText: 'Ukraine', shortText: 'UA', types: ['country'] },
  ]);
});
it('returns raw Google response text without parsing it', async () => {
  const client = createGoogleClientRaw(
    'stub',
    async () => new Response('{not json'),
  );
  await expect(
    client(
      { textQuery: 'x', languageCode: 'uk', regionCode: 'UA', pageSize: 20 },
      profile,
    ),
  ).resolves.toBe('{not json');
});
it('rejects HTTP and invalid JSON while skipping malformed places without retries', async () => {
  const bad = vi.fn(async () => new Response('', { status: 403 }));
  await expect(
    createGoogleClient('stub', bad)(
      { textQuery: 'x', languageCode: 'uk', regionCode: 'UA', pageSize: 20 },
      profile,
    ),
  ).rejects.toThrow('403');
  expect(bad).toHaveBeenCalledTimes(1);
  await expect(
    createGoogleClient('stub', async () => new Response('{invalid json'))(
      { textQuery: 'x', languageCode: 'uk', regionCode: 'UA', pageSize: 20 },
      profile,
    ),
  ).rejects.toThrow();
  const malformedPlace = await createGoogleClient('stub', async () =>
    Response.json({ places: [{}] }),
  )(
    { textQuery: 'x', languageCode: 'uk', regionCode: 'UA', pageSize: 20 },
    profile,
  );
  expect(malformedPlace.places).toEqual([]);
});
it('normalizes domains and rejects non-web or credentialed URLs', () => {
  expect(normalizeWebsite('https://www.Example.com/contact#top')).toEqual({
    website: 'https://www.example.com/contact',
    domain: 'example.com',
  });
  for (const v of [
    'javascript:alert(1)',
    'ftp://a.com',
    'https://user:pass@example.com',
    'broken',
  ])
    expect(normalizeWebsite(v)).toBeNull();
});
it('keeps website in default contacts and prevents Enterprise fields in cheap profile', () => {
  expect(profileSchema.safeParse(profile).success).toBe(true);
  expect(
    profileSchema.safeParse({
      ...profile,
      fields: ['places.id', 'nextPageToken'],
    }).success,
  ).toBe(false);
  expect(
    profileSchema.safeParse({ ...profile, id: 'basic', sku: 'Text Search Pro' })
      .success,
  ).toBe(false);
  expect(profilesSchema.safeParse([profile, profile]).success).toBe(false);
});
