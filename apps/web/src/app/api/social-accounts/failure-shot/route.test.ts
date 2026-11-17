import { beforeEach, expect, it, vi } from 'vitest';

const { query, apiUser } = vi.hoisted(() => ({
  query: vi.fn(),
  apiUser: vi.fn(),
}));
vi.mock('@/lib/api-access', () => ({
  apiUser,
  validId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
}));
vi.mock('@/i18n/uk', () => import('../../../../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { GET } from './route.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
beforeEach(() => {
  query.mockReset();
  apiUser.mockReset();
});

it('returns the JPEG with no-store headers for the account owner only', async () => {
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockImplementation(async (_sql: string, values: string[]) => ({
    rows:
      values[1] === 'owner'
        ? [{ jpeg: Buffer.from('jpeg').toString('base64') }]
        : [],
  }));
  const owned = await GET(
    new Request(
      `http://localhost/api/social-accounts/failure-shot?id=${id}&kind=check`,
    ),
  );
  expect(owned.status).toBe(200);
  expect(owned.headers.get('content-type')).toBe('image/jpeg');
  expect(owned.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await owned.arrayBuffer()).toString()).toBe('jpeg');
  expect(query.mock.calls[0]![1]).toEqual([id, 'owner', 'check']);

  apiUser.mockResolvedValue({ id: 'other-owner' });
  query.mockImplementation(async (_sql: string, values: string[]) => ({
    rows:
      values[1] === 'owner'
        ? [{ jpeg: Buffer.from('jpeg').toString('base64') }]
        : [],
  }));
  const denied = await GET(
    new Request(
      `http://localhost/api/social-accounts/failure-shot?id=${id}&kind=check`,
    ),
  );
  expect(denied.status).toBe(404);
});
