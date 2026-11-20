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
vi.mock('@/i18n/uk', () => import('../../../../../../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { GET, POST } from './route.js';

const accountId = '123e4567-e89b-12d3-a456-426614174000';
const url = `http://localhost/api/social-accounts/${accountId}/browser/dom`;
const sanitized = {
  version: 1,
  urlPattern: '/<id>',
  title: 'Facebook',
  truncated: false,
  nodes: [{ tag: 'div', text: '<text n=22>' }],
};
beforeEach(() => {
  query.mockReset();
  apiUser.mockReset();
});

it('captures only an owner account live DOM and retains the last ten sanitized snapshots', async () => {
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockImplementation(async (sql: string) =>
    sql.startsWith('select id') ? { rows: [{ id: accountId }] } : { rows: [] },
  );
  const originalUrl = process.env.SOCIAL_BROWSER_URL;
  const originalKey = process.env.SOCIAL_BROWSER_KEY;
  process.env.SOCIAL_BROWSER_URL = 'http://social-browser.test';
  process.env.SOCIAL_BROWSER_KEY = 'test-key';
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json(sanitized));
  try {
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Профіль компанії' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://social-browser.test/profiles/${accountId}/dom`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toContain('ordinal > jsonb_array_length');
    expect(query.mock.calls[1]![0]).toContain('-10');
    expect(query.mock.calls[1]![1][1]).toBe('owner');
    const saved = JSON.parse(query.mock.calls[1]![1][2])[0];
    expect(saved).toMatchObject({
      phase: 'manual',
      label: 'Профіль компанії',
      dom: { nodes: [{ text: '<text n=22>' }] },
    });
    expect(saved.capturedAt).toBeTruthy();
  } finally {
    fetcher.mockRestore();
    if (originalUrl === undefined) delete process.env.SOCIAL_BROWSER_URL;
    else process.env.SOCIAL_BROWSER_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SOCIAL_BROWSER_KEY;
    else process.env.SOCIAL_BROWSER_KEY = originalKey;
  }
});

it('denies another owner and returns a clear error when the browser is not running', async () => {
  apiUser.mockResolvedValue({ id: 'other-owner' });
  query.mockResolvedValue({ rows: [] });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  expect(
    (await POST(new Request(url, { method: 'POST', body: '{}' }))).status,
  ).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();

  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockResolvedValue({ rows: [{ id: accountId }] });
  const originalUrl = process.env.SOCIAL_BROWSER_URL;
  const originalKey = process.env.SOCIAL_BROWSER_KEY;
  process.env.SOCIAL_BROWSER_URL = 'http://social-browser.test';
  process.env.SOCIAL_BROWSER_KEY = 'test-key';
  const stopped = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ error: 'profile_not_running' }, { status: 409 }),
    );
  try {
    const response = await POST(
      new Request(url, { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('живий браузер');
  } finally {
    stopped.mockRestore();
    if (originalUrl === undefined) delete process.env.SOCIAL_BROWSER_URL;
    else process.env.SOCIAL_BROWSER_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SOCIAL_BROWSER_KEY;
    else process.env.SOCIAL_BROWSER_KEY = originalKey;
  }
});

it('lists metadata only for the owner and rejects labels longer than sixty characters', async () => {
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockImplementation(async (sql: string) =>
    sql.startsWith('select id')
      ? { rows: [{ id: accountId }] }
      : {
          rows: [
            {
              snapshots: [
                {
                  id: 'snap-id',
                  capturedAt: '2026-11-20T12:00:00.000Z',
                  label: 'test',
                  title: 'Facebook',
                  urlPattern: '/<id>',
                  dom: sanitized,
                },
              ],
            },
          ],
        },
  );
  const list = await GET(new Request(url));
  expect(await list.json()).toEqual([
    {
      id: 'snap-id',
      capturedAt: '2026-11-20T12:00:00.000Z',
      label: 'test',
      title: 'Facebook',
      urlPattern: '/<id>',
    },
  ]);
  const tooLong = await POST(
    new Request(url, {
      method: 'POST',
      body: JSON.stringify({ label: 'x'.repeat(61) }),
    }),
  );
  expect(tooLong.status).toBe(400);
});
