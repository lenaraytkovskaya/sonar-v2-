import { expect, it } from 'vitest';
import { manualCompanySchema, normalizeManualContact } from './manual.js';
import { extractSitePage } from './scanner.js';

it('normalizes manual contacts like site contacts with company-country phones', () => {
  expect(
    normalizeManualContact({ kind: 'email', value: ' Team@Sonar.test ' }, 'UA')
      ?.value,
  ).toBe('team@sonar.test');
  for (const [country, raw, expected] of [
    ['UA', '067 123 45 67', '+380671234567'],
    ['PL', '512 345 678', '+48512345678'],
    ['DE', '030 901820', '+4930901820'],
  ] as const)
    expect(
      normalizeManualContact({ kind: 'phone', value: raw }, country)?.value,
    ).toBe(expected);
  for (const [kind, value] of [
    ['telegram', 'https://t.me/sonar_team'],
    ['whatsapp', 'https://wa.me/380671234567'],
    ['viber', 'viber://chat?number=%2B380671234567'],
    ['social', 'https://instagram.com/sonar_team'],
  ] as const) {
    const scanned = extractSitePage(`<a href="${value}">Contact</a>`, {
      country: 'UA',
      url: 'https://sonar.test',
    }).contacts[0];
    expect(normalizeManualContact({ kind, value }, 'UA')).toEqual(scanned);
  }
  expect(
    normalizeManualContact({ kind: 'form', value: 'https://sonar.test' }, 'UA')
      ?.value,
  ).toBe('https://sonar.test/');
});
it('accepts a plain phone number as a Viber contact', () => {
  for (const raw of ['+380671234567', '067 123 45 67', '0671234567'])
    expect(normalizeManualContact({ kind: 'viber', value: raw }, 'UA')).toEqual(
      { kind: 'viber', value: '+380671234567', rank: 100 },
    );
  expect(
    normalizeManualContact({ kind: 'viber', value: '123' }, 'UA'),
  ).toBeNull();
});
it('rejects invalid addresses, mismatched messengers and unsafe form URLs', () => {
  for (const [kind, value] of [
    ['email', 'a@'],
    ['email', 'a b@sonar.test'],
    ['phone', '123'],
    ['telegram', 'https://t.me/share?url=x'],
    ['whatsapp', 'https://t.me/sonar_team'],
    ['social', 'https://instagram.com/p/post'],
    ['form', 'javascript:alert(1)'],
    ['form', 'https://user:secret@sonar.test/'],
  ] as const)
    expect(normalizeManualContact({ kind, value }, 'UA')).toBeNull();
});
it('requires a campaign and preserves an optional ISO country override', () => {
  const input = {
    name: ' Company ',
    campaignId: '608cc931-22dc-447f-8f06-a25975beb38b',
  };
  expect(manualCompanySchema.parse(input)).toMatchObject({ name: 'Company' });
  expect(manualCompanySchema.parse(input).countryCode).toBeUndefined();
  expect(
    manualCompanySchema.parse({ ...input, countryCode: 'pl' }).countryCode,
  ).toBe('PL');
  expect(
    normalizeManualContact({ kind: 'phone', value: '512 345 678' }, 'PL')
      ?.value,
  ).toBe('+48512345678');
  for (const patch of [
    { campaignId: '' },
    { name: '' },
    { countryCode: 'XX' },
    { website: 'not a website' },
  ])
    expect(manualCompanySchema.safeParse({ ...input, ...patch }).success).toBe(
      false,
    );
});
