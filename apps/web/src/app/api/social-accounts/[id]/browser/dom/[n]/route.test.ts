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
vi.mock('@/i18n/uk', () => import('../../../../../../../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { DELETE, GET } from './route.js';

const accountId = '123e4567-e89b-12d3-a456-426614174000';
const snapshotId = '123e4567-e89b-12d3-a456-426614174001';
const url = `http://localhost/api/social-accounts/${accountId}/browser/dom/${snapshotId}`;
beforeEach(() => {
  query.mockReset();
  apiUser.mockReset();
});

it('allows the owner to download and delete a saved JSON snapshot', async () => {
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('select id')) return { rows: [{ id: accountId }] };
    if (sql.startsWith('select settings'))
      return {
        rows: [
          {
            snapshots: [
              { id: snapshotId, phase: 'manual', dom: { nodes: [] } },
            ],
          },
        ],
      };
    return { rows: [{ id: accountId }] };
  });
  const download = await GET(new Request(url));
  expect(download.status).toBe(200);
  expect(download.headers.get('content-disposition')).toContain(snapshotId);
  expect(await download.json()).toEqual({
    id: snapshotId,
    phase: 'manual',
    dom: { nodes: [] },
  });
  const deleted = await DELETE(new Request(url, { method: 'DELETE' }));
  expect(deleted.status).toBe(200);
  expect(query.mock.calls.at(-1)?.[0]).toContain('owner_id=$2');
  expect(query.mock.calls.at(-1)?.[1]).toEqual([
    accountId,
    'owner',
    snapshotId,
  ]);
});

it('does not expose a snapshot to a different owner', async () => {
  apiUser.mockResolvedValue({ id: 'other-owner' });
  query.mockResolvedValue({ rows: [] });
  expect((await GET(new Request(url))).status).toBe(403);
  expect((await DELETE(new Request(url, { method: 'DELETE' }))).status).toBe(
    403,
  );
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0]?.[1]).toEqual([accountId, 'other-owner']);
});
