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
    expect(await response.json()).toMatchObject({
      error:
        'Екран Viber доступний призначеному власнику каналу. Для першого підключення увійдіть як власник CRM і натисніть «Підключити».',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
    if (originalUrl === undefined) delete process.env.VIBER_BRIDGE_URL;
    else process.env.VIBER_BRIDGE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VIBER_BRIDGE_KEY;
    else process.env.VIBER_BRIDGE_KEY = originalKey;
  }
});

it('serves the screen to its assigned owner without attempting to assign it', async () => {
  const originalUrl = process.env.VIBER_BRIDGE_URL;
  const originalKey = process.env.VIBER_BRIDGE_KEY;
  process.env.VIBER_BRIDGE_URL = 'http://viber-bridge.test';
  process.env.VIBER_BRIDGE_KEY = 'test-key';
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  );
  try {
    const response = await GET(
      new Request('http://localhost/api/viber/screen'),
    );
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('select 1');
    expect(query.mock.calls[0]?.[0]).not.toContain('update');
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
    if (originalUrl === undefined) delete process.env.VIBER_BRIDGE_URL;
    else process.env.VIBER_BRIDGE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VIBER_BRIDGE_KEY;
    else process.env.VIBER_BRIDGE_KEY = originalKey;
  }
});
