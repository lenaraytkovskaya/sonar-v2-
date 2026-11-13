import { afterEach, expect, it, vi } from 'vitest';
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch } }));
import {
  closeSocialBrowser,
  fetchSocialPage,
  socialDocumentUrls,
} from './social-browser.js';
const target = {
  network: 'instagram' as const,
  kind: 'profile' as const,
  handle: 'sonar',
  canonicalUrl: 'https://www.instagram.com/sonar/',
};
const proxy = {
  server: 'http://pinned.example:9000',
  username: 'private',
  password: 'secret',
};
const cookies = [
  {
    name: 'session',
    value: 'private-cookie',
    domain: '.instagram.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  },
];
afterEach(async () => {
  await closeSocialBrowser();
  vi.clearAllMocks();
});
function browserFixture(authenticated = true) {
  let current = target.canonicalUrl;
  let routeHandler: (route: unknown) => Promise<unknown>;
  const links = [
    '/p/PINNED/',
    '/p/LATEST/',
    '/p/PINNED/',
    'https://evil.test/p/EXTERNAL/',
    '/reel/THIRD/',
    '/p/FOURTH/',
    '/p/FIFTH/',
  ];
  const documents = new Map<string, string>();
  const page = {
    goto: vi.fn(async (url: string) => {
      current = url;
      await routeHandler({
        request: () => ({ url: () => url, isNavigationRequest: () => true }),
        continue: vi.fn(),
        abort: vi.fn(),
      });
      return { status: () => 200 };
    }),
    url: () => current,
    content: vi.fn(
      async () =>
        documents.get(current) ?? '<main><header>Sonar</header></main>',
    ),
    setDefaultTimeout: vi.fn(),
    routeWebSocket: vi.fn(),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(),
    locator: vi.fn((selector: string) =>
      selector.startsWith('main ')
        ? { evaluateAll: vi.fn(async () => links) }
        : {
            count: vi.fn(async () => 0),
            first: () => ({
              waitFor: vi.fn(async () => {
                if (!authenticated)
                  throw new Error('missing authenticated marker');
              }),
            }),
          },
    ),
    getByText: vi.fn(() => ({ count: vi.fn(async () => 0) })),
  };
  const context = {
    addCookies: vi.fn(),
    newPage: vi.fn(async () => page),
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
      routeHandler = handler;
    }),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
  launch.mockResolvedValue(browser);
  const session = { network: 'instagram' as const, proxy, cookies };
  return {
    browser,
    context,
    page,
    session,
    documents,
    route: () => routeHandler,
  };
}
it('renders through encrypted-session cookies and the pinned proxy, scrolls and opens only the first four distinct grid posts', async () => {
  const fixture = browserFixture();
  const result = await fetchSocialPage(
    target,
    { server: 'http://anonymous.example:8000' },
    1000,
    'SonarBot',
    fixture.session,
  );
  expect(fixture.browser.newContext).toHaveBeenCalledWith(
    expect.objectContaining({ proxy, serviceWorkers: 'block' }),
  );
  expect(fixture.context.addCookies).toHaveBeenCalledWith(cookies);
  expect(fixture.page.goto.mock.calls.map((call) => call[0])).toEqual([
    target.canonicalUrl,
    ...['p/PINNED/', 'p/LATEST/', 'reel/THIRD/', 'p/FOURTH/'].map(
      (path) => `https://www.instagram.com/${path}`,
    ),
  ]);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(5);
  expect(result).toMatchObject({
    usedProxy: true,
    proxyUnits: 5,
    documents: expect.any(Array),
  });
  expect(result.documents).toHaveLength(4);
  expect(fixture.context.close).toHaveBeenCalledOnce();
});
it('reports an invalid session when a public profile silently renders without authenticated markers', async () => {
  const fixture = browserFixture(false);
  const result = await fetchSocialPage(
    target,
    proxy,
    1000,
    'SonarBot',
    fixture.session,
  );
  expect(result).toMatchObject({
    error: 'session_invalid',
    proxyUnits: 1,
    usedProxy: true,
  });
  expect(fixture.page.goto).toHaveBeenCalledOnce();
});
it('stops at a checkpoint in a post and counts the attempted document without opening more posts', async () => {
  const fixture = browserFixture();
  fixture.documents.set(
    'https://www.instagram.com/p/PINNED/',
    '<main>Підтвердіть, що це ви</main>',
  );
  const result = await fetchSocialPage(
    target,
    proxy,
    1000,
    'SonarBot',
    fixture.session,
  );
  expect(result.proxyUnits).toBe(2);
  expect(result.url).toBe('https://www.instagram.com/p/PINNED/');
  expect(fixture.page.goto).toHaveBeenCalledTimes(2);
});
it('blocks local and external traffic and off-origin navigation while allowing the platform CDN through its pinned context', async () => {
  const fixture = browserFixture();
  await fetchSocialPage(target, proxy, 1000, 'SonarBot', fixture.session);
  for (const [url, navigation, allowed] of [
    ['http://127.0.0.1/private', false, false],
    ['https://evil.test/', false, false],
    ['https://www.instagram.com.evil.test/', false, false],
    ['https://static.cdninstagram.com/image.jpg', false, true],
    ['https://static.cdninstagram.com/', true, false],
    ['https://www.instagram.com/accounts/login/', true, true],
  ] as const) {
    const abort = vi.fn(),
      proceed = vi.fn();
    await fixture.route()({
      request: () => ({
        url: () => url,
        isNavigationRequest: () => navigation,
      }),
      abort,
      continue: proceed,
    });
    expect(allowed ? proceed : abort).toHaveBeenCalledOnce();
  }
});
it('selects contact/about and posts documents only within the original company profile', () => {
  expect(
    socialDocumentUrls(
      {
        ...target,
        network: 'facebook',
        canonicalUrl: 'https://www.facebook.com/profile.php?id=123',
      },
      [],
    ),
  ).toEqual([
    'https://www.facebook.com/profile.php?id=123&sk=about_contact_and_basic_info',
  ]);
  expect(
    socialDocumentUrls(
      {
        ...target,
        network: 'linkedin',
        kind: 'company',
        canonicalUrl: 'https://www.linkedin.com/company/sonar/',
      },
      [],
    ),
  ).toEqual([
    'https://www.linkedin.com/company/sonar/about/',
    'https://www.linkedin.com/company/sonar/posts/',
  ]);
});
