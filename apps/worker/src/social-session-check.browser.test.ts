import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  assertSocialSession,
  createSocialSendBrowser,
} from './social-send-browser.js';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'local LinkedIn session documents',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    const observed = readFileSync(
      new URL(
        '../../../packages/core/src/fixtures/social/linkedin-observed-header.html',
        import.meta.url,
      ),
      'utf8',
    );
    const authenticated =
      '<a hidden href="/messaging/hidden">Hidden</a><button class="global-nav__primary-link-me-menu-trigger">Me</button>';
    async function fixture(
      body: string,
      status = 200,
      path = '/',
      network: 'linkedin' | 'facebook' = 'linkedin',
    ) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // All resources are local; DNS and the launch proxy prevent external fallback.
        if (url.pathname === '/background')
          return route.fulfill({ status: 429, body: '{}' });
        return route.fulfill({
          status,
          contentType: 'text/html; charset=utf-8',
          body: `<script>history.replaceState(null, '', ${JSON.stringify(path)})</script>${body}`,
        });
      });
      const adapter = createSocialSendBrowser(
        async () =>
          ({
            newContext: async () => context,
            close: async () => {},
          }) as unknown as Browser,
      );
      const check = () =>
        adapter.check(
          { id: 'synthetic', channel: network, settings: {} },
          { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
          200,
        );
      return {
        context,
        adapter,
        check,
        setDocument: (nextBody: string, nextPath = '/', nextStatus = 200) => {
          body = nextBody;
          path = nextPath;
          status = nextStatus;
        },
      };
    }
    it.each([
      {
        body: '',
        reason: 'unknown_auth',
        kind: 'home',
        errorKind: 'timeout',
        auth: 0,
        login: 0,
        checkpoint: 0,
      },
      {
        body: '<a aria-label="Account">private</a>',
        status: 403,
        reason: 'unknown_auth',
        kind: 'home',
        errorKind: 'unconfirmed',
        auth: 1,
        login: 0,
        checkpoint: 0,
      },
      {
        body: '<input type="password" value="secret">',
        reason: 'login_required',
        kind: 'home',
        errorKind: 'unconfirmed',
        auth: 0,
        login: 1,
        checkpoint: 0,
      },
      {
        body: '',
        path: '/login/?private=secret',
        reason: 'login_required',
        kind: 'login',
        errorKind: 'unconfirmed',
        auth: 0,
        login: 0,
        checkpoint: 0,
      },
      {
        body: '<form action="/checkpoint/private"><button>private</button></form><input type="password">',
        reason: 'checkpoint',
        kind: 'home',
        errorKind: 'unconfirmed',
        auth: 0,
        login: 1,
        checkpoint: 1,
      },
      {
        body: '<script>setTimeout(() => history.replaceState(null, "", "/checkpoint/private?secret"), 30)</script>',
        reason: 'checkpoint',
        kind: 'checkpoint',
        errorKind: 'timeout',
        auth: 0,
        login: 0,
        checkpoint: 0,
      },
      {
        body: '<div data-testid="captcha">private</div>',
        reason: 'captcha',
        kind: 'home',
        errorKind: 'unconfirmed',
        auth: 0,
        login: 0,
        checkpoint: 0,
        captcha: 1,
      },
    ])(
      'attaches safe FB session diagnostic before page closure: $reason $kind',
      async (c) => {
        const f = await fixture(
          c.body,
          c.status ?? 200,
          c.path ?? '/',
          'facebook',
        );
        try {
          const error = await f.check().catch((e: unknown) => e);
          expect(error).toMatchObject({
            reason: c.reason,
            diagnostic: {
              version: 1,
              stage: 'auth',
              urlKind: c.kind,
              navigationHttpStatus: c.status ?? 200,
              errorKind: c.errorKind,
              visible: {
                legacyAuth: c.auth,
                semanticAuth: 0,
                login: c.login,
                checkpoint: c.checkpoint,
                captcha: c.captcha ?? 0,
              },
            },
          });
          expect(JSON.stringify(error)).not.toMatch(
            /private|secret|https|password|rawUrl/,
          );
          expect(f.context.pages()).toHaveLength(0);
        } finally {
          await f.adapter.close();
        }
      },
    );
    it('uses fresh FB evidence on every attempt in the cached context and never promotes unconfirmed auth', async () => {
      const f = await fixture('', 200, '/', 'facebook');
      try {
        const first = await f.check().catch((e: unknown) => e);
        expect(first).toMatchObject({
          reason: 'unknown_auth',
          diagnostic: { urlKind: 'home', visible: { login: 0 } },
        });
        f.setDocument('<input type="password">', '/messages/');
        await expect(f.check()).rejects.toMatchObject({
          reason: 'login_required',
          diagnostic: { urlKind: 'inbox', visible: { login: 1 } },
        });
        f.setDocument(
          '<a aria-label="Account">Account</a><input hidden type="password">',
        );
        await expect(f.check()).resolves.toBeUndefined();
        expect(first).toMatchObject({
          diagnostic: { urlKind: 'home', visible: { login: 0 } },
        });
        expect(f.context.pages()).toHaveLength(0);
      } finally {
        await f.adapter.close();
      }
    });
    it('preserves FB navigation timeout classification and null HTTP status', async () => {
      const f = await fixture('', 200, '/', 'facebook');
      f.context.on('page', (page) =>
        vi.spyOn(page, 'goto').mockRejectedValueOnce(
          Object.assign(Error('private URL secret'), {
            name: 'TimeoutError',
          }),
        ),
      );
      try {
        const error = await f.check().catch((e: unknown) => e);
        expect(error).toMatchObject({
          reason: 'timeout',
          diagnostic: {
            stage: 'navigation',
            urlKind: 'other',
            navigationHttpStatus: null,
            errorKind: 'timeout',
          },
        });
        expect(JSON.stringify(error)).not.toMatch(/private|secret|https/);
        expect(f.context.pages()).toHaveLength(0);
      } finally {
        await f.adapter.close();
      }
    });
    it('does not replace an FB auth error when diagnostic collection fails', async () => {
      const f = await fixture('<input type="password">', 200, '/', 'facebook');
      f.context.on('page', (page) =>
        vi.spyOn(page, 'getByRole').mockImplementation(() => {
          throw Error('private DOM secret');
        }),
      );
      try {
        const error = await f.check().catch((e: unknown) => e);
        expect(error).toMatchObject({ reason: 'login_required' });
        expect((error as { diagnostic?: unknown }).diagnostic).toBeUndefined();
        expect(JSON.stringify(error)).not.toMatch(/private|secret|https/);
        expect(f.context.pages()).toHaveLength(0);
      } finally {
        await f.adapter.close();
      }
    });
    it('accepts the observed semantic header without any legacy marker', async () => {
      const f = await fixture(observed, 200, '/feed/');
      try {
        const page = await f.context.newPage();
        await page.goto('https://www.linkedin.com/feed/');
        expect(
          await page
            .locator(
              'a[href*="/messaging/"], button.global-nav__primary-link-me-menu-trigger',
            )
            .count(),
        ).toBe(0);
        await page.close();
        await expect(f.check()).resolves.toBeUndefined();
      } finally {
        await f.adapter.close();
      }
    });
    it.each([
      ['/checkpoint/private-id?token=secret', 'checkpoint', 'checkpoint'],
      ['/login/?session=secret', 'login_required', 'login'],
      ['/feed/?tracking=secret', 'unknown_auth', 'feed'],
    ])(
      'rechecks negative evidence once after a late redirect to %s',
      async (path, reason, urlKind) => {
        const f = await fixture(
          `<script>setTimeout(() => history.replaceState(null, '', ${JSON.stringify(path)}), 50)</script>`,
          200,
          '/feed/',
        );
        try {
          const error = await f.check().catch((e) => e);
          expect(error).toMatchObject({
            reason,
            diagnostic: {
              version: 1,
              stage: 'auth',
              urlKind,
              navigationHttpStatus: 200,
              visible: { legacyAuth: 0, semanticAuth: 0 },
            },
          });
          if (reason === 'unknown_auth')
            expect(error).toMatchObject({
              errorKind: 'timeout',
              diagnostic: { errorKind: 'timeout' },
            });
          expect(JSON.stringify(error)).not.toMatch(
            /secret|private-id|https:|tracking|session=/,
          );
        } finally {
          await f.adapter.close();
        }
      },
    );
    it.each([
      [observed, 200, '/', null],
      [observed, 403, '/feed/', 'unknown_auth'],
      [observed + '<input type="password">', 200, '/feed/', 'login_required'],
      [
        observed + '<div data-testid="captcha">Verify</div>',
        200,
        '/feed/',
        'captcha',
      ],
      [
        observed + '<form action="/checkpoint">Verify</form>',
        200,
        '/feed/',
        'checkpoint',
      ],
      [
        observed +
          '<div hidden><input type="password"><div data-testid="captcha">Verify</div><p>Confirm your identity</p></div>',
        200,
        '/feed/',
        null,
      ],
      [observed + observed, 200, '/feed/', 'unknown_auth'],
      [
        observed.replace('aria-expanded="false"', ''),
        200,
        '/feed/',
        'unknown_auth',
      ],
      [
        observed.replace('https://www.linkedin.com/jobs/', '/public/'),
        200,
        '/feed/',
        'unknown_auth',
      ],
      [
        observed
          .replaceAll('<header>', '<main>')
          .replaceAll('</header>', '</main>'),
        200,
        '/feed/',
        'unknown_auth',
      ],
      [
        observed.replace('<nav>', '<nav hidden>'),
        200,
        '/feed/',
        'unknown_auth',
      ],
      [observed, 200, '/company/example/', 'unknown_auth'],
    ] as const)(
      'bounds semantic authentication: case %#',
      async (body, status, path, reason) => {
        const f = await fixture(body, status, path);
        try {
          if (reason) await expect(f.check()).rejects.toMatchObject({ reason });
          else await expect(f.check()).resolves.toBeUndefined();
        } finally {
          await f.adapter.close();
        }
      },
    );
    it('rejects matching navigation on an unrelated origin', async () => {
      const f = await fixture(observed);
      const page = await f.context.newPage();
      try {
        await page.goto('https://example.test/feed/');
        await expect(
          assertSocialSession(page, 'linkedin', 100),
        ).rejects.toMatchObject({ reason: 'unknown_auth' });
      } finally {
        await page.close();
        await f.adapter.close();
      }
    });
    it('reproduces both old hidden-element failures and passes the real visible-marker check', async () => {
      const f = await fixture(
        `${authenticated}<div hidden><input type="password"><iframe src="about:blank#captcha"></iframe><div data-testid="captcha"></div><form action="/checkpoint"></form><p>Confirm your identity</p></div>`,
      );
      try {
        const page = await f.context.newPage();
        page.setDefaultTimeout(100);
        await page.goto('https://www.linkedin.com/');
        expect(
          await page
            .locator(
              'input[type="password"], iframe[src*="captcha"], [data-testid="captcha"], form[action*="checkpoint"]',
            )
            .count(),
        ).toBe(4);
        expect(await page.getByText('Confirm your identity').count()).toBe(1);
        await expect(
          page
            .locator(
              'a[href*="/messaging/"], button.global-nav__primary-link-me-menu-trigger',
            )
            .first()
            .waitFor({ state: 'visible' }),
        ).rejects.toThrow();
        await expect(
          assertSocialSession(page, 'linkedin'),
        ).resolves.toBeUndefined();
        await page.close();
        await expect(f.check()).resolves.toBeUndefined();
      } finally {
        await f.adapter.close();
      }
    });
    it.each([
      ['<input type="password">', 200, '/', 'login_required'],
      ['<div data-testid="captcha">Verify</div>', 200, '/', 'captcha'],
      ['<p>Confirm your identity</p>', 200, '/', 'checkpoint'],
      ['<form action="/checkpoint">Verify</form>', 200, '/', 'checkpoint'],
      ['', 200, '/checkpoint/', 'checkpoint'],
      ['', 200, '/captcha/', 'captcha'],
      ['', 403, '/login/', 'login_required'],
      ['', 200, '/', 'unknown_auth'],
      [authenticated, 429, '/', 'rate_limit'],
      [authenticated, 407, '/', 'proxy'],
      [authenticated, 503, '/', 'network'],
      [authenticated, 403, '/', 'unknown_auth'],
    ] as const)(
      'fails closed: %s %s %s',
      async (body, status, path, reason) => {
        const f = await fixture(
          body +
            (reason === 'unknown_auth' && status === 200 ? '' : authenticated),
          status,
          path,
        );
        try {
          await expect(f.check()).rejects.toMatchObject({ reason });
        } finally {
          await f.adapter.close();
        }
      },
    );
    it('ignores background HTTP 429 while accepting the navigation document', async () => {
      const f = await fixture(
        `<script>fetch('/background').then(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(authenticated)}))</script>`,
      );
      try {
        await expect(f.check()).resolves.toBeUndefined();
      } finally {
        await f.adapter.close();
      }
    });
  },
);
