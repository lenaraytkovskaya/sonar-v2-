import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createSocialSendBrowser } from './social-send-browser.js';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Facebook fail-closed local HTML route',
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

    it.each(['personal', 'company', 'checkpoint'] as const)(
      'never inputs or sends from an unconfirmed %s chat',
      async (kind) => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const requests: string[] = [];
        const events: string[] = [];
        const mark = vi.fn(async () => {});
        const target =
          kind === 'company'
            ? 'https://www.facebook.com/synthetic_company/'
            : 'https://www.facebook.com/profile.php?id=100000000000001';
        await context.exposeBinding(
          'fixtureEvent',
          (_source, event: string) => {
            events.push(event);
          },
        );
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          requests.push(url);
          if (url !== target) return route.abort('blockedbyclient');
          // Adversarial synthetic markup, not a captured Facebook DOM contract.
          // Only the Lexical textbox attributes are based on root observations.
          await route.fulfill({
            contentType: 'text/html',
            body: `
              <nav aria-label="Account">Synthetic account</nav>
              <main><h1>Synthetic ${kind}</h1></main>
              <aside><a href="/unrelated/page_transparency/">Page transparency</a></aside>
              <div><header><a href="/100000000000002/">Other recipient</a></header>
                <div aria-label="You sent"><span>Synthetic message</span></div>
                <div contenteditable="true" role="textbox" aria-label="Write to Other recipient"
                  aria-placeholder="Aa" data-lexical-editor="true"><p dir="auto"></p></div>
                <button onclick="window.fixtureEvent('send')">Send</button>
              </div>
              ${kind === 'checkpoint' ? '<form action="/checkpoint/"><button>Continue</button></form>' : ''}
              <script>document.addEventListener('input', () => window.fixtureEvent('input'));</script>
            `,
          });
        });
        const adapter = createSocialSendBrowser(
          async () =>
            ({ newContext: async () => context }) as unknown as Browser,
        );
        try {
          await expect(
            adapter.send(
              { id: 'synthetic', channel: 'facebook', settings: {} },
              { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
              250,
              target,
              'Synthetic message',
              mark,
            ),
          ).rejects.toMatchObject(
            kind === 'checkpoint'
              ? { code: 'session_invalid', reason: 'checkpoint' }
              : {
                  code: 'unavailable',
                  reasonUk: expect.stringContaining(
                    'одержувача активного діалогу',
                  ),
                },
          );
          expect(requests).toEqual([target]);
          expect(events).toEqual([]);
          expect(mark).not.toHaveBeenCalled();
        } finally {
          await context.close();
        }
      },
    );
  },
);
