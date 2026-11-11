import { expect, it } from 'vitest';
import { parseAnalysis } from './analysis.js';
const value = {
  summary: 'Компанія ремонтує авто.',
  language: 'pl',
  best_channel: 'email',
  first_message: 'Dzień dobry!',
  fit: 75,
  fit_reason: 'Відповідає пропозиції.',
};
it('keeps company-language outreach and clears it when sender about is blank', () => {
  expect(
    parseAnalysis(JSON.stringify(value), [{ kind: 'email' }], 'Обладнання')
      .first_message,
  ).toBe('Dzień dobry!');
  expect(
    parseAnalysis(JSON.stringify(value), [{ kind: 'email' }], '  ')
      .first_message,
  ).toBe('');
});
it.each([
  { fit: 101 },
  { fit: -1 },
  { language: 'Polish' },
  { best_channel: 'social' },
  { fit: '70' },
])('rejects invalid schema %j', (change) => {
  expect(() =>
    parseAnalysis(
      JSON.stringify({ ...value, ...change }),
      [{ kind: 'email' }],
      'sender',
    ),
  ).toThrow();
});
it('rejects a channel not actually found and allows null when no contact exists', () => {
  expect(() =>
    parseAnalysis(JSON.stringify(value), [{ kind: 'phone' }], 'sender'),
  ).toThrow();
  expect(
    parseAnalysis(JSON.stringify({ ...value, best_channel: null }), [], '')
      .best_channel,
  ).toBeNull();
});
