import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const {
  connect,
  budgeted,
  query,
  release,
  acquireSession,
  reserveSession,
  pauseSession,
  releaseSession,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  budgeted: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  acquireSession: vi.fn(),
  reserveSession: vi.fn(),
  pauseSession: vi.fn(),
  releaseSession: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { connect } }));
vi.mock('@sonar/db/tasks', () => ({ boss: {}, runTask: vi.fn() }));
vi.mock('@sonar/db/social', () => ({ saveSocialProfile: vi.fn() }));
vi.mock('@sonar/db/scoring', () => ({ enqueueCompanyScores: vi.fn() }));
vi.mock('@sonar/db/social-accounts', () => ({
  acquireSocialFetchSession: acquireSession,
  reserveSocialFetchSession: reserveSession,
  pauseSocialFetchSession: pauseSession,
  releaseSocialFetchSession: releaseSession,
}));
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
beforeEach(() => acquireSession.mockResolvedValue(null));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  acquireSession.mockResolvedValue(null);
});

function prepareSocialFetch(overrides: Record<string, unknown> = {}) {
  vi.stubEnv(
    'SOCIAL_PROXY_URLS',
    'http://reserved.example:8000,http://anonymous.example:8000',
  );
  connect.mockResolvedValue({ query, release });
  const settings = {
    'social.account_proxy_index': 0,
    'social.cost_per_request_usd': 0.001,
    'social.page_timeout_ms': 30000,
    'social.instagram.min_gap_seconds': 60,
    'social.instagram.daily_limit': 100,
    'social.instagram.pause_minutes': 60,
    'social.instagram.session_fetch_daily_limit': 60,
    'social.instagram.session_fetch_gap_seconds': 90,
    ...overrides,
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
              : sql.includes('select payload')
                ? [{ payload: {} }]
                : [],
  }));
  budgeted.mockImplementation(async (_service, _estimate, _id, run) => run());
}
const authenticated = {
  account: { id: 'account', channel: 'instagram', settings: {} },
  session: {
    network: 'instagram',
    cookies: [],
    proxy: { server: 'http://pinned.example:9000' },
  },
};
const publicPage = {
  url: payload.target.canonicalUrl,
  status: 200,
  usedProxy: true,
  html: '<meta property="og:url" content="https://www.instagram.com/sonar/"><script type="application/json">{"username":"sonar","full_name":"Sonar","follower_count":12}</script>',
};
it('reads through the selected account pinned proxy and records an independent session reservation after budget approval', async () => {
  prepareSocialFetch();
  acquireSession.mockResolvedValue(authenticated);
  const fetch = vi.fn().mockResolvedValue(publicPage);
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'done',
    result: { profile: { method: 'session' } },
  });
  expect(fetch).toHaveBeenCalledWith(
    payload.target,
    authenticated.session.proxy,
    30000,
    'SonarBot/1.0',
    authenticated.session,
  );
  expect(reserveSession).toHaveBeenCalledWith(
    expect.anything(),
    'account',
    'request',
    90,
  );
  expect(releaseSession).toHaveBeenCalledWith(expect.anything(), 'account');
  expect(budgeted.mock.calls[0]?.[1]).toBe(0.006);
});
it.each(['accounts/login', 'checkpoint'])(
  'pauses precisely the invalid session after %s and falls back anonymously under the same paid request',
  async (path) => {
    prepareSocialFetch();
    acquireSession.mockResolvedValue(authenticated);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        html: '',
        url: `https://www.instagram.com/${path}/`,
        status: 200,
        usedProxy: true,
      })
      .mockResolvedValueOnce(publicPage);
    const outcome = await runSocialFetch(payload, 'task', fetch);
    expect(outcome).toMatchObject({
      status: 'done',
      result: { profile: { method: 'anonymous' }, costUsd: 0.002 },
    });
    expect(pauseSession).toHaveBeenCalledWith(expect.anything(), 'account');
    expect(fetch.mock.calls[1]).toHaveLength(4);
    expect(fetch.mock.calls[1]?.[1]).toEqual({
      server: 'http://anonymous.example:8000',
    });
    expect(budgeted).toHaveBeenCalledOnce();
    expect(reserveSession).toHaveBeenCalledOnce();
  },
);
it.each([
  { status: 429, html: '' },
  { status: 200, html: 'Please wait a few minutes before you try again' },
])(
  'preserves a session rate limit without anonymous fallback or invalidating cookies (%s)',
  async (page) => {
    prepareSocialFetch();
    acquireSession.mockResolvedValue(authenticated);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ...page,
        url: payload.target.canonicalUrl,
        usedProxy: true,
      })
      .mockResolvedValueOnce(publicPage);
    expect(await runSocialFetch(payload, 'task', fetch)).toEqual({
      status: 'paused',
      reasonCode: 'social_rate_limit',
      reasonUk:
        'Соцмережа обмежила запити (429). Повторіть вручну після паузи.',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toEqual(authenticated.session.proxy);
    expect(pauseSession).not.toHaveBeenCalled();
    const pauseUpdate = query.mock.calls.find(([sql]) =>
      sql.includes('value=value||'),
    );
    const pause = JSON.parse(pauseUpdate?.[1]?.[1]);
    expect(pause).toMatchObject({ blocked: true, blockCode: 'rate_limit' });
    expect(Date.parse(pause.pauseUntil)).toBeGreaterThan(Date.now());
    expect(pause.reason).not.toContain('cookies');
    expect(reserveSession).toHaveBeenCalledOnce();
    expect(releaseSession).toHaveBeenCalledWith(expect.anything(), 'account');
  },
);
it('defers the account reading gap without billing or reserving and uses anonymous reads when no account is usable', async () => {
  prepareSocialFetch();
  const runAt = new Date(Date.now() + 90000);
  acquireSession.mockResolvedValueOnce({ runAt });
  const fetch = vi.fn().mockResolvedValue(publicPage);
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'deferred',
    runAt,
    reasonCode: 'social_session_gap',
  });
  expect(budgeted).not.toHaveBeenCalled();
  expect(reserveSession).not.toHaveBeenCalled();
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'done',
    result: { profile: { method: 'anonymous' } },
  });
  expect(fetch.mock.calls[0]).toHaveLength(5);
  expect(fetch.mock.calls[0]?.[4]).toBeUndefined();
});
it('does not reserve a session or open either browser mode when budget is exhausted', async () => {
  prepareSocialFetch();
  acquireSession.mockResolvedValue(authenticated);
  budgeted.mockRejectedValue(new BudgetExceeded('monthly'));
  const fetch = vi.fn();
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'paused',
    reasonCode: 'budget_exceeded',
  });
  expect(reserveSession).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(releaseSession).toHaveBeenCalledWith(expect.anything(), 'account');
});
it('lets a newly active account recover an anonymous login wall while preserving shared protection pauses', async () => {
  prepareSocialFetch({
    'social.instagram.runtime': {
      blocked: true,
      blockCode: 'login_wall',
      pauseUntil: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  acquireSession.mockResolvedValue(authenticated);
  const fetch = vi.fn().mockResolvedValue(publicPage);
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'done',
    result: { profile: { method: 'session' } },
  });
  prepareSocialFetch({
    'social.instagram.runtime': {
      blocked: true,
      blockCode: 'captcha',
      reason: 'captcha',
      pauseUntil: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  fetch.mockClear();
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'paused',
    reasonCode: 'social_network_paused',
  });
  expect(fetch).not.toHaveBeenCalled();
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
it.each([undefined, null, '0', -1, 1.5, 2])(
  'fails closed for invalid reservation %s before billing',
  async (value) => {
    prepareSocialFetch({ 'social.account_proxy_index': value });
    const fetch = vi.fn();
    expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
      status: 'paused',
      reasonCode: 'social_proxy_reservation_invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(budgeted).not.toHaveBeenCalled();
  },
);
it('fails closed for an empty anonymous pool before billing, including duplicate credentials', async () => {
  prepareSocialFetch();
  vi.stubEnv(
    'SOCIAL_PROXY_URLS',
    'http://a:b@reserved.example:8000,http://c:d@reserved.example:8000',
  );
  const fetch = vi.fn();
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'paused',
    reasonCode: 'social_anonymous_proxy_missing',
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(budgeted).not.toHaveBeenCalled();
});
it('bills a failed session without invoking fallback when the anonymous pool is empty', async () => {
  prepareSocialFetch();
  vi.stubEnv('SOCIAL_PROXY_URLS', 'http://pinned.example:9000');
  acquireSession.mockResolvedValue(authenticated);
  const fetch = vi
    .fn()
    .mockResolvedValue({ ...publicPage, error: 'session_invalid' });
  expect(await runSocialFetch(payload, 'task', fetch)).toMatchObject({
    status: 'paused',
    reasonCode: 'social_anonymous_proxy_missing',
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(pauseSession).toHaveBeenCalledOnce();
  expect(budgeted).toHaveBeenCalledOnce();
  expect(await budgeted.mock.results[0]?.value).toMatchObject({
    costUsd: 0.001,
    units: 1,
  });
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
  vi.stubEnv(
    'SOCIAL_PROXY_URLS',
    'http://reserved.example:8000,http://user:password@proxy.example:8000',
  );
  connect.mockResolvedValue({ query, release });
  const settings = {
    'social.account_proxy_index': 0,
    'social.cost_per_request_usd': 0.001,
    'social.page_timeout_ms': 30000,
    'social.instagram.min_gap_seconds': 60,
    'social.instagram.daily_limit': 100,
    'social.instagram.pause_minutes': 60,
    'social.instagram.session_fetch_daily_limit': 60,
    'social.instagram.session_fetch_gap_seconds': 90,
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
  vi.stubEnv(
    'SOCIAL_PROXY_URLS',
    'http://reserved.example:8000,http://proxy.example:8000',
  );
  connect.mockResolvedValue({ query, release });
  const settings = {
    'social.account_proxy_index': 0,
    'social.cost_per_request_usd': 0.001,
    'social.page_timeout_ms': 30000,
    'social.instagram.min_gap_seconds': 60,
    'social.instagram.daily_limit': 100,
    'social.instagram.pause_minutes': 60,
    'social.instagram.session_fetch_daily_limit': 60,
    'social.instagram.session_fetch_gap_seconds': 90,
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
