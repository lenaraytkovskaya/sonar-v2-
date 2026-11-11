import { expect, it } from 'vitest';
import {
  companyFiltersSchema,
  filtersFromParams,
  parseCompanyFilters,
  csvRow,
} from './company.js';
it('validates AI filters including false without accepting raw SQL or unknown keys', () => {
  expect(
    parseCompanyFilters('{"hasWebsite":true,"hasPhone":false,"minRating":4.5}'),
  ).toEqual({ hasWebsite: true, hasPhone: false, minRating: 4.5 });
  for (const value of [
    '{"sql":"DROP TABLE companies"}',
    '{"minRating":6}',
    '{"hasWebsite":"true"}',
    '{"status":"bad"}',
    'not json',
  ])
    expect(() => parseCompanyFilters(value)).toThrow();
  expect(companyFiltersSchema.safeParse({ q: "' OR 1=1 --" }).success).toBe(
    true,
  );
});
it('parses query flags without converting false to true', () => {
  expect(
    filtersFromParams(new URLSearchParams('hasPhone=false&minRating=4.5')),
  ).toEqual({ hasPhone: false, minRating: 4.5 });
  expect(() =>
    filtersFromParams(new URLSearchParams('hasPhone=yes')),
  ).toThrow();
});
it('CSV quotes commas, newlines and quotes and neutralizes spreadsheet formulas', () => {
  expect(
    csvRow([
      'Компанія, Київ',
      'say "hello"',
      'line\nbreak',
      null,
      '=1+1',
      '+380442223344',
    ]),
  ).toBe(
    '"Компанія, Київ","say ""hello""","line\nbreak","","\'=1+1","\'+380442223344"\r\n',
  );
});
