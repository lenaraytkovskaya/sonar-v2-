import { expect, it, vi } from 'vitest';
vi.mock('./index.js', () => ({ sonarPool: {} }));
vi.mock('./tasks.js', () => ({ enqueueTask: vi.fn(), logActivity: vi.fn() }));
vi.mock('./budget.js', () => ({ checkGooglePlanBudget: vi.fn() }));
import {
  campaignProgress,
  ContinuationUnavailable,
  resultsExhausted,
} from './batches.js';
const legacy = {
  queries: ['q1', 'q2'],
  cities: ['c1', 'c2'],
  language_code: 'pl',
};
it('recovers paid legacy batch responses under their original language and index', async () => {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('select google_progress'))
      return { rows: [{ google_progress: {} }] };
    if (sql.startsWith('select * from batches'))
      return {
        rows: [{ id: 'old', config: legacy, requests: 1, cursor: { pair: 0 } }],
      };
    if (sql.startsWith('select s.meta'))
      return {
        rows:
          values?.[1] === 'google.request:old:0:%'
            ? [
                {
                  text: JSON.stringify({
                    places: [{ id: 'paid-place' }],
                    nextPageToken: 'paid-token',
                  }),
                },
              ]
            : [],
      };
    return { rows: [] };
  });
  const progress = await campaignProgress({ query } as never, 'campaign');
  expect(progress['["q1","c1","pl"]']).toMatchObject({
    pages: 1,
    token: 'paid-token',
    buffer: [{ id: 'paid-place' }],
  });
  expect(progress['["q1","c1","en"]']).toBeUndefined();
  expect(
    query.mock.calls
      .filter(([sql]) => sql.startsWith('select s.meta'))
      .map(([, values]) => values?.[1]),
  ).toEqual([0, 1, 2, 3].map((i) => `google.request:old:${i}:%`));
});
it('refuses to refetch a paid first page when no recoverable receipt exists', async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ google_progress: {} }] })
    .mockResolvedValueOnce({
      rows: [{ id: 'old', config: legacy, requests: 1, cursor: { pair: 0 } }],
    })
    .mockResolvedValue({ rows: [] });
  await expect(
    campaignProgress({ query } as never, 'campaign'),
  ).rejects.toBeInstanceOf(ContinuationUnavailable);
});
it('does not declare other languages exhausted after consuming one language', () => {
  const progress = {
    '["q","c","pl"]': { pages: 1, exhausted: true, buffer: [] },
  };
  expect(resultsExhausted(['q'], ['c'], progress, ['pl'])).toBe(true);
  expect(resultsExhausted(['q'], ['c'], progress, ['pl', 'en'])).toBe(false);
});
