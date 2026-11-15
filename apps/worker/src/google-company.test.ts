import { beforeEach, expect, it, vi } from 'vitest';
import { BudgetExceeded, PaidHttpError } from '@sonar/core';
const { query, tx, budget } = vi.hoisted(() => ({
  query: vi.fn(),
  tx: vi.fn(),
  budget: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/email', () => ({
  transaction: async (fn: (c: { query: typeof tx }) => unknown) =>
    fn({ query: tx }),
}));
vi.mock('@sonar/db/tasks', () => ({
  TaskFailure: class extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(reasonUk);
    }
  },
}));
vi.mock('@sonar/db/budget', () => ({
  runBudgetedRequest: budget,
  BillingUncertain: class extends Error {},
  paidErrorReason: () => 'Помилка Google.',
}));
import { runGoogleCompany } from './google-company.js';
const placeId = 'ChIJj61dQgK6j4AR4GeTYWZsKWw';
const sourceUrl = `https://www.google.com/maps/search/?api=1&query=${placeId}&query_place_id=${placeId}`;
const payload = {
  companyId: 'company',
  campaignId: 'campaign',
  placeId,
  sourceUrl,
};
const place = {
  id: placeId,
  displayName: { text: 'Source company' },
  formattedAddress: 'Source address',
  websiteUri: 'https://example.com/',
  internationalPhoneNumber: '+380443387518',
};
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('from companies')
      ? [{ google_maps_uri: sourceUrl, country_code: 'UA' }]
      : [
          { key: 'google.details.price_usd', value: 0.02 },
          { key: 'scanner.timeout_ms', value: 1000 },
          { key: 'retention.google_days', value: 365 },
        ],
  }));
  tx.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('select') ? [{ google_maps_uri: sourceUrl }] : [],
  }));
  budget.mockImplementation(async (_s, _p, _t, operation) => operation());
});
it('uses a fixed official endpoint and budgeted tariff, preserving company identity', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(place));
  expect(await runGoogleCompany(payload, 'task', fetcher)).toMatchObject({
    status: 'done',
    result: { placeId, sourceUrl },
  });
  expect(budget).toHaveBeenCalledWith(
    'google_places',
    0.02,
    'task',
    expect.any(Function),
  );
  expect(fetcher).toHaveBeenCalledWith(
    `https://places.googleapis.com/v1/places/${placeId}`,
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({
        'X-Goog-FieldMask': expect.stringContaining('websiteUri'),
      }),
    }),
  );
  expect(tx.mock.calls.some(([sql]) => sql.includes('update companies'))).toBe(
    false,
  );
  expect(
    tx.mock.calls.filter(([sql]) => sql.includes('insert into company_facts')),
  ).toHaveLength(2);
});
it('skips changed targets before any paid request', async () => {
  query.mockResolvedValueOnce({
    rows: [{ google_maps_uri: 'https://other.example' }],
  });
  const fetcher = vi.fn();
  expect(await runGoogleCompany(payload, 'task', fetcher)).toMatchObject({
    reasonCode: 'source_changed',
  });
  expect(budget).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not save a result when the target changed during HTTP', async () => {
  const fetcher = vi.fn(async () => {
    tx.mockResolvedValue({ rows: [{ google_maps_uri: 'changed' }] });
    return Response.json(place);
  });
  expect(await runGoogleCompany(payload, 'task', fetcher)).toMatchObject({
    reasonCode: 'source_changed',
  });
  expect(tx.mock.calls.some(([sql]) => sql.includes('insert'))).toBe(false);
});
it('refuses forged place identity in a successful response', async () => {
  await expect(
    runGoogleCompany(
      payload,
      'task',
      vi.fn().mockResolvedValue(Response.json({ ...place, id: 'other' })),
    ),
  ).rejects.toThrow('інший Place ID');
  expect(tx).not.toHaveBeenCalled();
});
it('does not follow arbitrary source URLs', async () => {
  const fetcher = vi.fn();
  await expect(
    runGoogleCompany(
      { ...payload, sourceUrl: 'http://localhost/admin' },
      'task',
      fetcher,
    ),
  ).rejects.toThrow('Некоректне');
  expect(fetcher).not.toHaveBeenCalled();
});
it('pauses on budget failure without making an HTTP request', async () => {
  budget.mockRejectedValueOnce(new BudgetExceeded('monthly'));
  const fetcher = vi.fn();
  expect(await runGoogleCompany(payload, 'task', fetcher)).toMatchObject({
    status: 'paused',
    reasonCode: 'budget_exceeded',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('turns provider HTTP failures into useful task errors', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
  await expect(runGoogleCompany(payload, 'task', fetcher)).rejects.toThrow(
    'Помилка Google',
  );
});
it('records HTTP failures through budget accounting', async () => {
  budget.mockRejectedValueOnce(new PaidHttpError(429));
  await expect(runGoogleCompany(payload, 'task', vi.fn())).rejects.toThrow(
    'Помилка Google',
  );
});
