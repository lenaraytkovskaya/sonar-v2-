import { beforeEach, expect, it, vi } from 'vitest';

const { query, apiUser } = vi.hoisted(() => ({
  query: vi.fn(),
  apiUser: vi.fn(),
}));
vi.mock('@/lib/api-access', () => ({ apiUser }));
vi.mock('@/i18n/uk', () => import('../../../../../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/core/social-session', () => ({
  resolveSocialSession: vi.fn(),
}));
import { GET, POST } from './route.js';

const url =
  'http://localhost/api/social-accounts/11111111-1111-4111-8111-111111111111/browser';
beforeEach(() => {
  query.mockReset();
  apiUser.mockReset();
});

it('does not expose a browser screen to another owner', async () => {
  apiUser.mockResolvedValue({ id: 'other-user' });
  query.mockResolvedValue({ rows: [] });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const originalUrl = process.env.SOCIAL_BROWSER_URL;
  const originalKey = process.env.SOCIAL_BROWSER_KEY;
  process.env.SOCIAL_BROWSER_URL = 'http://social-browser.test';
  process.env.SOCIAL_BROWSER_KEY = 'test-key';
  try {
    expect((await GET(new Request(url))).status).toBe(403);
    expect(
      (
        await POST(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'open' }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
    if (originalUrl === undefined) delete process.env.SOCIAL_BROWSER_URL;
    else process.env.SOCIAL_BROWSER_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SOCIAL_BROWSER_KEY;
    else process.env.SOCIAL_BROWSER_KEY = originalKey;
  }
});
