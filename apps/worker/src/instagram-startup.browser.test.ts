import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
vi.mock('./social-inbox.js', () => ({
  SocialInboxAdapterError: class extends Error {},
}));

import { captureInstagramInbox } from './instagram-inbox-browser.js';
import { renderSocialDocuments } from './social-browser.js';

// Startup regression models the reported logo-only screen. No live IG DOM/API data.
describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Instagram startup',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
    afterAll(async () => browser?.close());

    it.each(['inbox', 'profile'] as const)(
      'waits for a delayed %s splash before reading authenticated content',
      async (path) => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        const requests: string[] = [];
        const persist = vi.fn();
        await context.route('**/*', (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            contentType: 'text/html',
            body: `<div id="splash-screen" aria-label="Instagram logo">Instagram</div>
            <main hidden><a href="/direct/inbox/">Messages</a><h1>Ready profile</h1></main>
            <script>setTimeout(() => { document.querySelector('#splash-screen').remove(); document.querySelector('main').hidden = false; }, 70)</script>`,
          });
        });
        try {
          if (path === 'inbox') {
            await expect(
              captureInstagramInbox(page, 350, persist, undefined, '90001'),
            ).resolves.toMatchObject({
              skipped: ['no_verified_mailbox', 'requests_and_spam_unverified'],
            });
          } else {
            const result = await renderSocialDocuments(
              page,
              {
                network: 'instagram',
                kind: 'profile',
                handle: 'fixture_company',
                canonicalUrl: 'https://www.instagram.com/fixture_company/',
              },
              350,
            );
            expect(result.error).toBeUndefined();
            expect(result.html).not.toContain('id="splash-screen"');
          }
          expect(await page.locator('#splash-screen').count()).toBe(0);
          expect(requests).toHaveLength(1);
          expect(persist).not.toHaveBeenCalled();
        } finally {
          await context.close();
        }
      },
    );

    it.each([200, 403, 429])(
      'handles home GraphQL HTTP %s while recovering an inbox splash',
      async (graphqlStatus) => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        const requests: string[] = [];
        let homeVisited = false;
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          requests.push(url.pathname);
          if (url.pathname === '/api/graphql')
            return route.fulfill({
              status: graphqlStatus,
              contentType: 'application/json',
              body: '{}',
            });
          if (url.pathname === '/') homeVisited = true;
          return route.fulfill({
            contentType: 'text/html',
            body:
              url.pathname === '/'
                ? '<main><nav><a hidden href="/direct/inbox/">Messages</a></nav></main><script>fetch("/api/graphql", {method: "POST"}).then(() => document.querySelector("a").hidden = false)</script>'
                : homeVisited
                  ? '<main><nav><a href="/direct/inbox/">Messages</a></nav></main>'
                  : '<div id="splash-screen" aria-label="Instagram logo">Instagram</div>',
          });
        });
        try {
          const persist = vi.fn();
          const result = captureInstagramInbox(
            page,
            120,
            persist,
            undefined,
            '90001',
          );
          if (graphqlStatus === 200)
            await expect(result).resolves.toMatchObject({
              skipped: ['no_verified_mailbox', 'requests_and_spam_unverified'],
            });
          else
            await expect(result).rejects.toMatchObject({
              reason: graphqlStatus === 429 ? 'rate_limit' : 'unknown_auth',
            });
          expect(requests).toContain('/api/graphql');
          expect(requests.filter((path) => path !== '/api/graphql')).toEqual([
            '/direct/inbox/',
            '/',
            ...(graphqlStatus === 200 ? ['/direct/inbox/'] : []),
          ]);
          expect(persist).not.toHaveBeenCalled();
        } finally {
          await context.close();
        }
      },
    );

    it('keeps profile extraction on public documents when its splash never clears', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const requests: string[] = [];
      await context.route('**/*', (route) => {
        requests.push(new URL(route.request().url()).pathname);
        return route.fulfill({
          contentType: 'text/html',
          body: '<div id="splash-screen">Instagram</div>',
        });
      });
      try {
        await expect(
          renderSocialDocuments(
            page,
            {
              network: 'instagram',
              kind: 'profile',
              handle: 'fixture_company',
              canonicalUrl: 'https://www.instagram.com/fixture_company/',
            },
            120,
          ),
        ).resolves.toMatchObject({ error: 'network_error' });
        expect(requests).toEqual(['/fixture_company/']);
      } finally {
        await context.close();
      }
    });
  },
);
