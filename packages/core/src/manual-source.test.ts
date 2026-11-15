import { describe, expect, it } from 'vitest';
import {
  normalizeManualSource,
  manualGoogleMaps,
  type ManualSourceInput,
} from './manual-source.js';
const input = (
  source: ManualSourceInput['source'],
  value: string,
  network?: ManualSourceInput['network'],
) => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  source,
  value,
  network,
});
describe('manual sources', () => {
  it.each(['example.com', 'https://EXAMPLE.com/#fragment', 'www.example.com'])(
    'normalizes website %s',
    (value) => {
      expect(normalizeManualSource(input('website', value))).toMatchObject({
        domain: 'example.com',
      });
    },
  );
  it('normalizes a bare international domain with URL IDNA rules', () =>
    expect(normalizeManualSource(input('website', 'приклад.com')).value).toBe(
      'https://xn--80aikifvh.com/',
    ));
  it.each([
    'file:///etc/passwd',
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
    'https://company.local',
    'https://user:password@example.com',
    'https://example.com:444/',
    'https://example.com\\@evil.com',
    'https://example.com/has space',
  ])('rejects unsafe website %s', (value) =>
    expect(() => normalizeManualSource(input('website', value))).toThrow(
      'invalidWebsite',
    ),
  );
  const placeId = 'ChIJj61dQgK6j4AR4GeTYWZsKWw';
  it.each([
    `https://www.google.com/maps/search/?api=1&query=Company&query_place_id=${placeId}`,
    `https://maps.google.com/?q=place_id:${placeId}`,
    `https://google.com/maps/place/?q=place_id:${placeId}`,
  ])('extracts only explicit Google Place IDs from %s', (value) =>
    expect(manualGoogleMaps(value)).toMatchObject({ placeId }),
  );
  it.each([
    'https://maps.app.goo.gl/abc',
    'https://goo.gl/maps/abc',
    'https://www.google.com/maps/place/Company/@1,2',
    'https://maps.google.com/?cid=123',
    `https://google.com.evil.com/maps/?query_place_id=${placeId}`,
    `http://google.com/maps/?query_place_id=${placeId}`,
    `https://google.com/url?query_place_id=${placeId}`,
    `https://google.com/maps/?query_place_id=${placeId}&q=place_id:other`,
    'https://google.com/maps/?query_place_id=../../admin',
  ])('rejects ambiguous or unsafe Maps URL %s', (value) =>
    expect(manualGoogleMaps(value)).toBeNull(),
  );
  it.each([
    ['facebook', '@company.name', 'https://www.facebook.com/company.name/'],
    ['instagram', '@company_name', 'https://www.instagram.com/company_name/'],
    [
      'linkedin',
      '@company-name',
      'https://www.linkedin.com/company/company-name/',
    ],
    [
      undefined,
      'instagram.com/Company/?utm_source=x',
      'https://www.instagram.com/company/',
    ],
    [
      undefined,
      'https://www.facebook.com/pages/Company/123456789',
      'https://www.facebook.com/profile.php?id=123456789',
    ],
    [
      undefined,
      'https://www.facebook.com/profile.php?id=123456789',
      'https://www.facebook.com/profile.php?id=123456789',
    ],
    [
      undefined,
      'https://www.linkedin.com/school/company/',
      'https://www.linkedin.com/school/company/',
    ],
  ] as const)('normalizes social %s %s', (network, value, canonical) =>
    expect(
      normalizeManualSource(input('social', value, network)),
    ).toMatchObject({ value: canonical }),
  );
  it('requires a network for ambiguous handles', () =>
    expect(() => normalizeManualSource(input('social', '@company'))).toThrow(
      'networkRequired',
    ));
  it.each([
    'https://instagram.com/p/123/',
    'https://instagram.com/bad..name/',
    'https://facebook.com/company/posts/123',
    'https://linkedin.com/in/person/',
    'https://instagram.com.evil.com/company',
    'https://facebook.com/login',
    'https://www.linkedin.com/company/example/posts/',
  ])('rejects unsupported social %s', (value) =>
    expect(() => normalizeManualSource(input('social', value))).toThrow(
      'invalidSocial',
    ),
  );
  it.each(['@', '@bad/name', '@bad..name', '@trailing.'])(
    'rejects malformed Instagram handle %s',
    (value) =>
      expect(() =>
        normalizeManualSource(input('social', value, 'instagram')),
      ).toThrow('invalidSocial'),
  );
  it('does not ignore an explicit network mismatch', () =>
    expect(() =>
      normalizeManualSource(
        input('social', 'https://facebook.com/company', 'instagram'),
      ),
    ).toThrow('invalidSocial'));
  it.each(['00123456', '0123456789'])(
    'preserves leading zeros in code %s',
    (value) =>
      expect(normalizeManualSource(input('registry', value)).value).toBe(value),
  );
  it.each([
    '1234',
    '123456789',
    '1234567x',
    'https://example.com',
    '12345678;drop',
  ])('rejects invalid code %s', (value) =>
    expect(() => normalizeManualSource(input('registry', value))).toThrow(
      'invalidCode',
    ),
  );
});
