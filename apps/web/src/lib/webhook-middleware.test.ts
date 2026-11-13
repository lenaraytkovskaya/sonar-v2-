import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { unseal } = vi.hoisted(() => ({ unseal: vi.fn() }));
vi.mock('iron-session', () => ({ unsealData: unseal }));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@/lib/session', () => ({
  sessionOptions: () => ({ cookieName: 'test', password: 'test', ttl: 60 }),
}));
import { middleware } from '../middleware';

beforeEach(() => {
  vi.clearAllMocks();
  unseal.mockResolvedValue({});
});

it('allows only the two signature-guarded webhook endpoints without a login', async () => {
  for (const path of ['/api/webhooks/resend', '/api/webhooks/waha'])
    expect(
      (await middleware(new NextRequest(`http://localhost${path}`))).status,
    ).toBe(200);
  expect(unseal).not.toHaveBeenCalled();
  for (const path of ['/api/webhooks/unknown', '/api/webhooks/resend/other'])
    expect(
      (await middleware(new NextRequest(`http://localhost${path}`))).status,
    ).toBe(401);
  expect(unseal).toHaveBeenCalledTimes(2);
});
