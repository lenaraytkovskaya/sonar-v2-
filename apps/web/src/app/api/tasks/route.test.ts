import { beforeEach, expect, it, vi } from 'vitest';
const { apiUser, overview } = vi.hoisted(() => ({
  apiUser: vi.fn(),
  overview: vi.fn(),
}));
vi.mock('@/lib/api-access', () => ({
  apiUser,
  validId: (id: unknown) =>
    typeof id === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id),
}));
vi.mock('@/i18n/uk', () => import('../../../i18n/uk'));
vi.mock('@sonar/db/task-overview', () => ({ taskOverviewData: overview }));
import { GET } from './route.js';
const id = '83d7c52f-6aaa-47b1-aa49-c40d738cc44e';
beforeEach(() => {
  vi.clearAllMocks();
  apiUser.mockResolvedValue({ id: 'user' });
});
it('guards unauthenticated requests before DB access', async () => {
  apiUser.mockResolvedValue(null);
  expect(
    (await GET(new Request(`http://localhost/api/tasks?campaignId=${id}`)))
      .status,
  ).toBe(401);
  expect(overview).not.toHaveBeenCalled();
});
it.each(['', 'bad', '" OR true--'])(
  'rejects malformed campaign identifiers before DB access (%s)',
  async (value) => {
    expect(
      (
        await GET(
          new Request(
            `http://localhost/api/tasks?campaignId=${encodeURIComponent(value)}`,
          ),
        )
      ).status,
    ).toBe(400);
    expect(overview).not.toHaveBeenCalled();
  },
);
it('returns404 for an absent campaign and only scoped data for an existing one', async () => {
  overview.mockResolvedValueOnce(null);
  expect(
    (await GET(new Request(`http://localhost/api/tasks?campaignId=${id}`)))
      .status,
  ).toBe(404);
  const data = {
    tasks: [],
    counts: [],
    failures: [],
    olderFailures: [],
    batches: [],
  };
  overview.mockResolvedValueOnce(data);
  const response = await GET(
    new Request(`http://localhost/api/tasks?campaignId=${id}&status=paused`),
  );
  expect(await response.json()).toEqual(data);
  expect(overview).toHaveBeenLastCalledWith({
    campaignId: id,
    status: 'paused',
    type: null,
  });
});
