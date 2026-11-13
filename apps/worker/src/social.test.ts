import { afterEach, expect, it, vi } from 'vitest';
const { connect, budgeted, query, release } = vi.hoisted(() => ({
  connect: vi.fn(),
  budgeted: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { connect } }));
vi.mock('@sonar/db/tasks', () => ({ boss: {}, runTask: vi.fn() }));
vi.mock('@sonar/db/social', () => ({ saveSocialProfile: vi.fn() }));
vi.mock('@sonar/db/scoring', () => ({ enqueueCompanyScores: vi.fn() }));
vi.mock('@sonar/db/budget', () => ({
  runBudgetedRequest: budgeted,
  BillingUncertain: class extends Error {
    constructor() {
      super('Billing uncertain');
    }
  },
}));
import { BudgetExceeded } from '@sonar/core';
import { socialProxies } from './social-browser.js';
import { runSocialFetch, socialLimit } from './social.js';
const payload = {
  companyId: 'company',
  target: {
    network: 'instagram' as const,
    kind: 'profile' as const,
    handle: 'sonar',
    canonicalUrl: 'https://www.instagram.com/sonar/',
  },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('pauses without a proxy before connecting to the database or starting a browser', async () => {
  vi.stubEnv('SOCIAL_PROXY_URLS', '');
  const fetch = vi.fn();
  expect(await runSocialFetch(payload, 'task', fetch)).toEqual({
    status: 'paused',
    reasonCode: 'social_proxy_missing',
    reasonUk: 'Додайте SOCIAL_PROXY_URLS на сервері',
  });
  expect(connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('parses HTTP proxy credentials and reports malformed values without leaking credentials', () => {
  expect(
    socialProxies(
      'https://user:p%40ss@proxy.example:9000,http://other.example:8000',
    ),
  ).toEqual([
    {
      server: 'https://proxy.example:9000',
      username: 'user',
      password: 'p@ss',
    },
    { server: 'http://other.example:8000' },
  ]);
  expect(() =>
    socialProxies('socks5://secret:password@proxy.example:9000'),
  ).toThrow('Некоректне налаштування SOCIAL_PROXY_URLS');
});
it('requires manual retry after protection pauses even after the pause expires and resets daily counts at UTC midnight', () => {
  const config = { 'social.instagram.daily_limit': 2 };
  const now = new Date('2026-11-13T01:00:00Z');
  const paused = {
    blocked: true,
    pauseUntil: '2026-11-12T23:00:00Z',
    reason: 'captcha',
  };
  expect(socialLimit(config, 'instagram', paused, false, now)).toBe('captcha');
  expect(socialLimit(config, 'instagram', paused, true, now)).toBeNull();
  expect(
    socialLimit(
      config,
      'instagram',
      { ...paused, pauseUntil: '2026-11-13T02:00:00Z' },
      true,
      now,
    ),
  ).toBe('captcha');
  expect(
    socialLimit(
      config,
      'instagram',
      { day: '2026-11-13', count: 2 },
      false,
      now,
    ),
  ).toContain('денний ліміт');
  expect(
    socialLimit(
      config,
      'instagram',
      { day: '2026-11-12', count: 2 },
      false,
      now,
    ),
  ).toBeNull();
});
it('checks proxy budget before invoking paid traffic', async () => {
  vi.stubEnv('SOCIAL_PROXY_URLS', 'http://user:password@proxy.example:8000');
  connect.mockResolvedValue({ query, release });
  const settings = {
    'social.cost_per_request_usd': 0.001,
    'social.page_timeout_ms': 30000,
    'social.instagram.min_gap_seconds': 60,
    'social.instagram.daily_limit': 100,
    'social.instagram.pause_minutes': 60,
  };
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('pg_try_advisory')
      ? [{ locked: true }]
      : sql.includes('select key,value')
        ? Object.entries(settings).map(([key, value]) => ({ key, value }))
        : sql.includes('select idempotency_key,payload')
          ? [{ idempotency_key: 'social.fetch:instagram:sonar:2026-11-13' }]
          : sql.includes('insert into tasks')
            ? [{ id: 'request' }]
            : sql.includes('coalesce(c.country_code')
              ? [{ country_code: 'UA' }]
              : [],
  }));
  budgeted.mockRejectedValue(new BudgetExceeded('monthly'));
  const fetch = vi.fn();
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'paused',
    reasonCode: 'budget_exceeded',
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
it('does not follow redirects outside the approved social origin and bounds proxy requests', async () => {
  const { readSocialDocuments } = await import('./social-browser.js');
  const get = vi.fn().mockResolvedValueOnce({
    status: () => 302,
    headers: () => ({ location: 'http://127.0.0.1/private' }),
  });
  const result = await readSocialDocuments(
    { get },
    payload.target,
    1000,
    'SonarBot',
  );
  expect(result.error).toBe('network_error');
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.every((call) => call[1].maxRedirects === 0)).toBe(true);
});
it('reads public company pages without consulting robots.txt (owner decision)', async () => {
  const { readSocialDocuments } = await import('./social-browser.js');
  const get = vi.fn().mockResolvedValue({
    status: () => 200,
    text: async () => '<html><title>Sonar</title></html>',
  });
  expect(
    await readSocialDocuments({ get }, payload.target, 1000, 'SonarBot'),
  ).toMatchObject({ status: 200, html: expect.stringContaining('Sonar') });
  expect(get).toHaveBeenCalledOnce();
  expect(String(get.mock.calls[0]?.[0])).not.toContain('robots.txt');
});
it('records zero cost when Chromium cannot start before any proxy traffic', async () => {
  vi.stubEnv('SOCIAL_PROXY_URLS', 'http://proxy.example:8000');
  connect.mockResolvedValue({ query, release });
  const settings = {
    'social.cost_per_request_usd': 0.001,
    'social.page_timeout_ms': 30000,
    'social.instagram.min_gap_seconds': 60,
    'social.instagram.daily_limit': 100,
    'social.instagram.pause_minutes': 60,
  };
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('pg_try_advisory')
      ? [{ locked: true }]
      : sql.includes('select key,value')
        ? Object.entries(settings).map(([key, value]) => ({ key, value }))
        : sql.includes('select idempotency_key,payload')
          ? [{ idempotency_key: 'social.fetch:instagram:sonar:2026-11-13' }]
          : sql.includes('insert into tasks')
            ? [{ id: 'request' }]
            : sql.includes('coalesce(c.country_code')
              ? [{ country_code: 'UA' }]
              : [],
  }));
  let billed: unknown;
  budgeted.mockImplementation(async (_s, _e, _id, run) => {
    billed = await run();
    return billed;
  });
  const { chromium } = await import('playwright');
  const { fetchSocialPage, closeSocialBrowser } =
    await import('./social-browser.js');
  await closeSocialBrowser();
  const launch = vi
    .spyOn(chromium, 'launch')
    .mockRejectedValueOnce(new Error('startup failed'));
  try {
    expect(
      await runSocialFetch(payload, 'task', fetchSocialPage),
    ).toMatchObject({ status: 'skipped', reasonCode: 'social_network_error' });
    expect(billed).toMatchObject({ costUsd: 0, units: 0 });
  } finally {
    launch.mockRestore();
    await closeSocialBrowser();
  }
});
