import { beforeEach, expect, it, vi } from 'vitest';
const { budgeted } = vi.hoisted(() => ({
  budgeted: vi.fn(async (_service, _estimate, _id, run) => run()),
}));
vi.mock('@sonar/db', () => ({ sonarPool: {} }));
vi.mock('@sonar/db/budget', async (original) => ({
  ...(await original<object>()),
  runBudgetedRequest: budgeted,
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  logActivity: vi.fn(),
  TaskFailure: class extends Error {},
}));
import { OpenRouterError } from '@sonar/core';
import { aiEvidencePage, aiSiteFallback, scanSite } from './site.js';
import {
  publicAddress,
  SiteHttp,
  SiteUnavailable,
  type SiteResponse,
} from './site-http.js';
const settings = {
  maxPages: 12,
  maxBytes: 2000000,
  timeoutMs: 1000,
  userAgent: 'SonarBot/1.0',
};
const home = 'https://shop.com/';
function response(
  url: string,
  body = '',
  status = 200,
  contentType = 'text/html',
  location?: string,
): SiteResponse {
  return { url, body: Buffer.from(body), status, contentType, location };
}
function website(documents: Record<string, string | SiteResponse>, rules = '') {
  const request = vi.fn(async (url: URL) => {
    if (url.pathname === '/robots.txt')
      return response(url.href, rules, 200, 'text/plain');
    const item = documents[url.href];
    return typeof item === 'string'
      ? response(url.href, item)
      : (item ?? response(url.href, '', 404));
  });
  return { http: new SiteHttp(home, settings, request), request };
}
beforeEach(() => {
  vi.clearAllMocks();
  budgeted.mockImplementation(async (_s, _e, _i, run) => run());
});
it.each([
  '127.0.0.1',
  '10.3.2.1',
  '169.254.169.254',
  '100.64.1.2',
  '172.20.2.1',
  '192.168.2.4',
  '::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '2002:7f00:1::',
  '2001:db8::1',
])('blocks private and non-global network address %s', (ip) =>
  expect(publicAddress(ip)).toBe(false),
);
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
  'permits public address %s',
  (ip) => expect(publicAddress(ip)).toBe(true),
);
it('checks robots before page fetch and redirects to another origin', async () => {
  const { http, request } = website(
    {
      [home]: response(
        home,
        '',
        301,
        'text/html',
        'https://www.shop.com/private',
      ),
    },
    'User-agent: *\nDisallow: /private',
  );
  await expect(http.read(home)).rejects.toMatchObject({
    code: 'robots_denied',
  });
  expect(request.mock.calls.map(([url]) => url.href)).toEqual([
    'https://shop.com/robots.txt',
    home,
    'https://www.shop.com/robots.txt',
  ]);
});
it('rejects cross-domain redirects, credentials and non-http urls', async () => {
  const { http } = website({
    [home]: response(home, '', 302, '', 'http://127.0.0.1/'),
  });
  await expect(http.read(home)).rejects.toBeInstanceOf(SiteUnavailable);
  await expect(
    http.read('https://user:secret@shop.com/'),
  ).rejects.toBeInstanceOf(SiteUnavailable);
  await expect(http.read('file:///etc/passwd')).rejects.toBeInstanceOf(
    SiteUnavailable,
  );
});
it('orders contact links and sitemap before ordinary links, then stops with email phone messenger', async () => {
  const { http, request } = website({
    [home]:
      '<a href="/news">News</a><a href="/contacts">Contact</a><a href="https://other.com/contact">Other</a>',
    'https://shop.com/sitemap.xml': response(
      'https://shop.com/sitemap.xml',
      '<urlset><url><loc>https://shop.com/about</loc></url><url><loc>https://shop.com/item</loc></url></urlset>',
      200,
      'application/xml',
    ),
    'https://shop.com/contacts':
      '<a href="mailto:hello@shop.com">Email</a><a href="tel:+380673142758">Call</a><a href="https://t.me/shop">Telegram</a>',
  });
  const persist = vi.fn();
  const pages = await scanSite(http, 'UA', persist);
  expect(pages.map((page) => page.url)).toEqual([
    home,
    'https://shop.com/contacts',
  ]);
  expect(request.mock.calls.map(([url]) => url.href)).not.toContain(
    'https://shop.com/news',
  );
  expect(persist).toHaveBeenCalledTimes(2);
});
it('uses browser only for an empty SPA main page and respects max pages', async () => {
  const { request } = website({
    [home]: '<div id="root"></div><script src="/app.js"></script>',
  });
  const render = vi.fn(
    async () => '<a href="/about">About</a><p>hello@shop.com</p>',
  );
  const pages = await scanSite(
    new SiteHttp(home, { ...settings, maxPages: 1 }, request),
    'UA',
    vi.fn(),
    render,
  );
  expect(pages).toHaveLength(1);
  expect(render).toHaveBeenCalledOnce();
});
it.each([403, 429])(
  'does not launch browser to bypass HTTP %i',
  async (status) => {
    const { http } = website({
      [home]: response(home, '<div id="root"></div>', status),
    });
    const render = vi.fn();
    await expect(scanSite(http, 'UA', vi.fn(), render)).rejects.toMatchObject({
      code: `http_${status}`,
    });
    expect(render).not.toHaveBeenCalled();
  },
);
it('does not launch browser to bypass Cloudflare challenge', async () => {
  const { http } = website({
    [home]:
      '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test.js"></script>',
  });
  const render = vi.fn();
  await expect(scanSite(http, 'UA', vi.fn(), render)).rejects.toMatchObject({
    code: 'challenge',
  });
  expect(render).not.toHaveBeenCalled();
});
const config = {
  'scanner.ai_fallback': true,
  'scanner.ai_max_usd': 0.002,
  'scanner.ai_max_tokens': 600,
  'scanner.ai_prompt': 'Extract JSON only',
  'ai.models': [
    { id: 'stub', promptUsd: 0, completionUsd: 0, requestUsd: 0.001 },
  ],
  'ai.model.cheap': 'stub',
};
const pages = [
  {
    url: home,
    text: 'hello (at) shop dot com',
    contacts: [],
    facts: [],
    links: [],
    spa: false,
    challenge: null,
  },
];
function aiClient(text: string) {
  return {
    complete: vi.fn(async () => ({
      text,
      costUsd: 0.001,
      units: 10,
      id: 'stub',
      model: 'stub',
    })),
    models: vi.fn(),
  };
}
it('validates AI contacts, tags provenance and uses budgeted cached response on retry', async () => {
  const client = aiClient(
    '{"emails":["hello@shop.com"],"phones":[],"messengers":[],"edrpou":[]}',
  );
  const cache = new Map<string, unknown>();
  budgeted.mockImplementation(async (_s, _e, id, run) => {
    if (!cache.has(id)) cache.set(id, await run());
    return cache.get(id);
  });
  const first = await aiSiteFallback(pages, 'UA', config, 'same-task', client);
  await aiSiteFallback(pages, 'UA', config, 'same-task', client);
  expect(first).toMatchObject({
    aiUsed: true,
    costUsd: 0.001,
    contacts: [{ kind: 'email', meta: { ai: true } }],
  });
  expect(client.complete).toHaveBeenCalledTimes(1);
});
it.each(['not json', '{"emails":"bad"}'])(
  'ignores invalid AI response %s',
  async (text) => {
    expect(
      await aiSiteFallback(pages, 'UA', config, 'task', aiClient(text)),
    ).toMatchObject({
      aiUsed: true,
      aiStatus: 'invalid_response',
      contacts: [],
      costUsd: 0.001,
    });
  },
);
it('skips AI when estimated price exceeds site ceiling or model is not configured', async () => {
  const client = aiClient('{}');
  expect(
    await aiSiteFallback(
      pages,
      'UA',
      { ...config, 'scanner.ai_max_usd': 0.0001 },
      'task',
      client,
    ),
  ).toMatchObject({ aiStatus: 'price_limit' });
  expect(
    await aiSiteFallback(
      pages,
      'UA',
      { ...config, 'ai.model.cheap': '' },
      'task',
      client,
    ),
  ).toMatchObject({ aiStatus: 'missing_model' });
  expect(budgeted).not.toHaveBeenCalled();
});
it('preserves uncertain billing as paused rather than dropping reservation', async () => {
  budgeted.mockRejectedValue(new OpenRouterError('network_unavailable'));
  await expect(
    aiSiteFallback(pages, 'UA', config, 'task', aiClient('{}')),
  ).rejects.toThrow('Результат попереднього платного запиту невідомий');
});

it('counts unsuccessful pages toward the configured crawl ceiling', async () => {
  const { request } = website({
    [home]:
      '<a href="/about">About</a><a href="/contact">Contact</a><a href="/other">Other</a>',
  });
  await scanSite(
    new SiteHttp(home, { ...settings, maxPages: 2 }, request),
    'UA',
    vi.fn(),
  );
  expect(request.mock.calls.map(([url]) => url.href)).not.toContain(
    'https://shop.com/contact',
  );
});
it('gives all three AI input pages a text allowance and selects their actual contact source', async () => {
  const client = aiClient(
    '{"emails":["sales@shop.com","invented@shop.com"],"phones":[],"messengers":[],"edrpou":[]}',
  );
  const input = [
    { ...pages[0]!, text: 'a'.repeat(9000) },
    {
      ...pages[0]!,
      url: 'https://shop.com/about',
      text: 'sales (at) shop dot com',
    },
    { ...pages[0]!, url: 'https://shop.com/contact', text: 'third page' },
  ];
  const result = await aiSiteFallback(input, 'UA', config, 'task', client);
  const calls = client.complete.mock.calls as unknown as [
    string,
    { content: string }[],
    number,
  ][];
  const content = JSON.parse(calls[0]![1][1]!.content);
  expect(content).toHaveLength(3);
  expect(content[0].text).toHaveLength(2000);
  expect(content[2].text).toBe('third page');
  expect(result.contacts.map((contact) => contact.value)).toEqual([
    'sales@shop.com',
  ]);
  expect(aiEvidencePage(result.contacts[0]!.value, input)?.url).toBe(
    'https://shop.com/about',
  );
});

it('does not turn a billing persistence failure into a successful scan', async () => {
  budgeted.mockRejectedValue(new Error('settlement storage unavailable'));
  await expect(
    aiSiteFallback(pages, 'UA', config, 'task', aiClient('{}')),
  ).rejects.toThrow('settlement storage unavailable');
});
