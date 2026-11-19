import { beforeEach, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
import { chromium } from 'playwright';
import {
  connectSocialProfile,
  lockSocialProfile,
} from './social-profile-browser.js';

beforeEach(() => {
  query.mockReset();
});

it('connects account operations to the persistent CDP profile and pinned proxy', async () => {
  query.mockResolvedValue({
    rows: [
      { key: 'social.browser.max_profiles', value: 3 },
      { key: 'social.browser.idle_ms', value: 1800000 },
    ],
  });
  const context = { pages: () => [{}] };
  const browser = { contexts: () => [context] };
  const connect = vi
    .spyOn(chromium, 'connectOverCDP')
    .mockResolvedValue(browser as never);
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ port: 9402, instance: 'instance-1' }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl:
            'ws://127.0.0.1:9302/devtools/browser/instance-1',
        }),
        { status: 200 },
      ),
    );
  const oldUrl = process.env.SOCIAL_BROWSER_URL;
  const oldKey = process.env.SOCIAL_BROWSER_KEY;
  process.env.SOCIAL_BROWSER_URL = 'http://social-browser:3000';
  process.env.SOCIAL_BROWSER_KEY = 'private-test-key';
  try {
    const result = await connectSocialProfile(
      {
        id: '11111111-1111-4111-8111-111111111111',
        channel: 'facebook',
        settings: { browserProfile: true },
      },
      {
        cookies: [],
        proxy: {
          server: 'http://proxy.example:8000',
          username: 'account',
          password: 'secret',
        },
      } as never,
    );
    expect(result).toEqual({ browser, context });
    expect(connect).toHaveBeenCalledWith(
      'ws://social-browser:9402/devtools/browser/instance-1',
    );
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      network: 'facebook',
      maxProfiles: 3,
      proxy: { server: 'http://proxy.example:8000' },
    });
    expect(payload.proxy.password).toBe('secret');
  } finally {
    connect.mockRestore();
    fetcher.mockRestore();
    if (oldUrl === undefined) delete process.env.SOCIAL_BROWSER_URL;
    else process.env.SOCIAL_BROWSER_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SOCIAL_BROWSER_KEY;
    else process.env.SOCIAL_BROWSER_KEY = oldKey;
  }
});

it('requires the profile lock before running worker page operations', async () => {
  const oldUrl = process.env.SOCIAL_BROWSER_URL;
  const oldKey = process.env.SOCIAL_BROWSER_KEY;
  process.env.SOCIAL_BROWSER_URL = 'http://social-browser:3000';
  process.env.SOCIAL_BROWSER_KEY = 'private-test-key';
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('', { status: 409 }));
  try {
    await expect(
      lockSocialProfile('11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('social_browser_profile_busy');
  } finally {
    fetcher.mockRestore();
    if (oldUrl === undefined) delete process.env.SOCIAL_BROWSER_URL;
    else process.env.SOCIAL_BROWSER_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SOCIAL_BROWSER_KEY;
    else process.env.SOCIAL_BROWSER_KEY = oldKey;
  }
});
