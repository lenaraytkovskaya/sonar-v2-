import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    const authenticated =
      '<a hidden href="/messaging/hidden">Hidden</a><button class="global-nav__primary-link-me-menu-trigger">Me</button>';
    async function fixture(body: string, status = 200, path = '/') {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // All resources are local; DNS and the launch proxy prevent external fallback.
        if (url.pathname === '/background')
          return route.fulfill({ status: 429, body: '{}' });
        return route.fulfill({
          status,
          contentType: 'text/html',
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
          { id: 'synthetic', channel: 'linkedin', settings: {} },
          { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
          200,
        );
      return { context, adapter, check };
    }
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
