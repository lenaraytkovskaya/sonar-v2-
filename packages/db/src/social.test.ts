import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
vi.mock('./index.js', () => ({ sonarPool: {} }));
vi.mock('./tasks.js', () => ({
  enqueueTask: vi.fn(),
  logActivity: vi.fn(),
  retryTask: vi.fn(),
}));
import { prepareSocialRetry, type SocialPayload } from './social.js';
const payload: SocialPayload = {
  companyId: 'company',
  target: {
    network: 'instagram',
    kind: 'profile',
    handle: 'sonar',
    canonicalUrl: 'https://www.instagram.com/sonar/',
  },
  requestVersion: 2,
};
it('prevents another billed attempt until an uncertain child is reconciled', async () => {
  const query = vi.fn(async () => ({ rows: [{ id: 'pending-child' }] }));
  expect(
    await prepareSocialRetry({ query } as unknown as PoolClient, {
      id: 'parent',
      payload,
    }),
  ).toBe(false);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0]).toContain(
    "result->>'billingPending'='true'",
  );
});
it('recovers a terminal parent after a crash before a child billing reservation', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  expect(
    await prepareSocialRetry({ query } as unknown as PoolClient, {
      id: 'parent',
      payload,
    }),
  ).toBe(true);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0]?.[0]).not.toContain('status in');
  expect(query.mock.calls[1]?.[1]).toEqual([
    'parent',
    JSON.stringify({ requestVersion: 3, manual: true }),
  ]);
});
