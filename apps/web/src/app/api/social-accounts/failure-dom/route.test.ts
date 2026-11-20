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

it('returns the DOM with no-store headers for the account owner only', async () => {
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockImplementation(async (_sql: string, values: string[]) => ({
    rows: values[1] === 'owner' ? [{ dom: { version: 1, nodes: [] } }] : [],
  }));
  const owned = await GET(
    new Request(
      `http://localhost/api/social-accounts/failure-dom?id=${id}&kind=check`,
    ),
  );
  expect(owned.status).toBe(200);
  expect(owned.headers.get('content-type')).toContain('application/json');
  expect(owned.headers.get('cache-control')).toBe('no-store');
  expect(await owned.json()).toEqual({ version: 1, nodes: [] });
  expect(query.mock.calls[0]![0]).toContain('owner_id=$2');
  expect(query.mock.calls[0]![1]).toEqual([id, 'owner', 'check']);

  apiUser.mockResolvedValue({ id: 'other-owner' });
  query.mockImplementation(async (_sql: string, values: string[]) => ({
    rows: values[1] === 'owner' ? [{ dom: { version: 1, nodes: [] } }] : [],
  }));
  const denied = await GET(
    new Request(
      `http://localhost/api/social-accounts/failure-dom?id=${id}&kind=check`,
    ),
  );
  expect(denied.status).toBe(404);
});

it('rejects unauthenticated and malformed requests before querying', async () => {
  const request = (query: string) =>
    new Request(`http://localhost/api/social-accounts/failure-dom?${query}`);
  apiUser.mockResolvedValue(null);
  expect((await GET(request(`id=${id}&kind=send`))).status).toBe(401);
  apiUser.mockResolvedValue({ id: 'owner' });
  expect((await GET(request(`id=${id}&kind=other`))).status).toBe(400);
  expect((await GET(request('id=invalid&kind=send'))).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
