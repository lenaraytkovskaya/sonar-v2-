import type { EventEmitter } from 'node:events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
const profile = vi.hoisted(() => ({
  context: null as BrowserContext | null,
  browser: {},
}));
vi.mock('./social-profile-browser.js', () => ({
  connectSocialProfile: async () => ({
    context: profile.context,
    browser: profile.browser,
  }),
  lockSocialProfile: async () => async () => {},
}));
import { createSocialSendBrowser } from './social-send-browser.js';
let browser: Browser;
beforeAll(async () => {
  if (process.env.RUN_BROWSER_TESTS === '1')
    browser = await chromium.launch({
      headless: true,
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
    });
});
afterAll(async () => browser?.close());
it.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'lets retained home startup finish before navigation and reuses one tab without retaining listeners',
  async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    profile.context = context;
    await context.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<div id="splash-screen" style="position:fixed;inset:0;background:white;z-index:10">Instagram</div><script>setTimeout(() => { document.body.innerHTML = `<main><a href="/direct/inbox/">Ready</a></main>`; }, 180)</script>',
      }),
    );
    const page = await context.newPage();
    await page.goto('https://www.instagram.com/');
    const adapter = createSocialSendBrowser();
    const account = {
      id: 'fixture',
      channel: 'instagram' as const,
      settings: { browserProfile: true },
    };
    const session = {
      cookies: [],
      proxy: { server: 'http://fixture.invalid' },
    };
    try {
      const events = page as unknown as EventEmitter;
      const before = events.listenerCount('response');
      for (let index = 0; index < 2; index++)
        await adapter.withPage(account, session, 1000, async (selected) => {
          expect(selected).toBe(page);
          expect(await selected.locator('#splash-screen').count()).toBe(0);
          expect(await selected.locator('main').count()).toBe(1);
        });
      expect(context.pages()).toEqual([page]);
      expect(events.listenerCount('response')).toBe(before);
      expect(events.listenerCount('requestfailed')).toBe(0);
    } finally {
      await adapter.close();
      await context.close();
    }
  },
);
