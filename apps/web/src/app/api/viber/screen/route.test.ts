import { beforeEach, expect, it, vi } from 'vitest';

const { query, apiUser } = vi.hoisted(() => ({
  query: vi.fn(),
  apiUser: vi.fn(),
}));
vi.mock('@/lib/api-access', () => ({ apiUser }));
vi.mock('@/i18n/uk', () => import('../../../../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { GET } from './route.js';

beforeEach(() => {
  query.mockReset();
  apiUser.mockReset();
});

it('does not expose the Viber screen to a user who does not own the channel', async () => {
  const originalUrl = process.env.VIBER_BRIDGE_URL;
  const originalKey = process.env.VIBER_BRIDGE_KEY;
  process.env.VIBER_BRIDGE_URL = 'http://viber-bridge.test';
  process.env.VIBER_BRIDGE_KEY = 'test-key';
  apiUser.mockResolvedValue({ id: 'another-user' });
  query.mockResolvedValue({ rows: [] });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    const response = await GET(
      new Request('http://localhost/api/viber/screen'),
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
    if (originalUrl === undefined) delete process.env.VIBER_BRIDGE_URL;
    else process.env.VIBER_BRIDGE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VIBER_BRIDGE_KEY;
    else process.env.VIBER_BRIDGE_KEY = originalKey;
  }
});
