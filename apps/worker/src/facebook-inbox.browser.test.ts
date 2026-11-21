import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  captureFacebookHot,
  captureFacebookInbox,
  readFacebookRequestPreviews,
  readFacebookThread,
} from './facebook-inbox-browser.js';
import type { SocialInboxBatch } from '@sonar/core/social-inbox';
import {
  SocialSessionCheckError,
  safeSocialSessionDiagnostic,
} from '@sonar/core/social-session';

// Structural capture from the repository; message IDs below use the msgr shape
// confirmed by root in native DevTools on 2026-11-15. No real identities retained.
const captured = readFileSync(
  new URL('./facebook-chat.sanitized.fixture.html', import.meta.url),
  'utf8',
).replace(
  /data-message-id="synthetic-id-(\d+)"/g,
  'data-message-id="100000000000001@msgr.$1"',
);
const path = '/messages/e2ee/t/900000000000001/';
const requestsFixture = readFileSync(
  new URL('./facebook-requests.sanitized.fixture.html', import.meta.url),
  'utf8',
);
describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Facebook observed inbox DOM',
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
    async function fixture(
      html: string | ((path: string) => string) = captured,
    ) {
      const context = await browser.newContext({
        timezoneId: 'Europe/Warsaw',
        serviceWorkers: 'block',
      });
      const navigations: string[] = [];
      await context.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        navigations.push(url.pathname);
        if (request.method() !== 'GET' || url.hostname !== 'www.facebook.com')
          return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body:
            typeof html === 'function'
              ? `<a aria-label="Your profile">Profile</a>${html(url.pathname)}`
              : url.pathname === '/messages/'
                ? `<a aria-label="Your profile">Profile</a><section role="region" aria-label="Thread list"><table aria-label="Chats"><tbody><tr><td><a href="${path}">Synthetic Recipient</a></td></tr></tbody></table></section>`
                : `<a aria-label="Your profile">Profile</a>${html}`,
        });
      });
      const page = await context.newPage();
      await page.goto(`https://www.facebook.com${path}`);
      return { page, context, navigations };
    }
    it('reads the captured structure, binds peer/self, preserves both identical outgoing IDs and repeats stable IDs', async () => {
      const { page, context } = await fixture();
      try {
        const first = await readFacebookThread(page, '100000000000002');
        expect(first.skipped).toEqual([]);
        expect(
          first.messages.map((m) => [m.direction, m.externalMessageId]),
        ).toEqual([
          ['out', '100000000000001@msgr.5'],
          ['out', '100000000000001@msgr.6'],
          ['in', '100000000000001@msgr.7'],
          ['in', '100000000000001@msgr.8'],
        ]);
        expect(first.messages[0]).toMatchObject({
          senderProfile: 'https://www.facebook.com/100000000000002/',
          peerProfile: 'https://www.facebook.com/100000000000001/',
          threadId: '900000000000001',
          occurredAt: '2026-11-04T19:15:00.000Z',
          body: 'Synthetic message 1',
        });
        await page.reload();
        expect(
          (await readFacebookThread(page, '100000000000002')).messages.map(
            (m) => m.externalMessageId,
          ),
        ).toEqual(first.messages.map((m) => m.externalMessageId));
        // Consecutive messages need no repeated sender heading.
        await page
          .locator('[data-message-id] h2')
          .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
        expect(
          (await readFacebookThread(page, '100000000000002')).messages,
        ).toHaveLength(4);
      } finally {
        await context.close();
      }
    });
    it('imports only the flagged chat by opening it inside the open page', async () => {
      const { page, context, navigations } = await fixture();
      try {
        await page.goto('https://www.facebook.com/messages/');
        const batches: SocialInboxBatch[] = [];
        const result = await captureFacebookHot(
          page,
          '100000000000002',
          [path, '/messages/t/999/', 'not-a-thread'],
          5000,
          async (batch) => {
            batches.push(batch);
          },
          { keep: true },
          100,
          { '900000000000001': { lastMessageId: '100000000000001@msgr.6' } },
        );
        expect(navigations).toContain(path);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.resumeAnchor).toEqual({ keep: true });
        expect(batches[0]!.messages.map((m) => m.externalMessageId)).toEqual([
          '100000000000001@msgr.7',
          '100000000000001@msgr.8',
        ]);
        expect(result.skipped).toContain('history_unavailable');
      } finally {
        await context.close();
      }
    });
    it("reports the newest own message that carries the peer's seen avatar", async () => {
      const { page, context } = await fixture();
      try {
        // The captured chat already shows the seen avatar under our last message.
        const read = await readFacebookThread(page, '100000000000002');
        expect(read.seenMessageId).toBe('100000000000001@msgr.6');
        expect(read.threadId).toBe('900000000000001');
        await page.evaluate(() => {
          document
            .querySelectorAll('[data-message-id="100000000000001@msgr.6"] img')
            .forEach((img) => img.remove());
        });
        expect(
          (await readFacebookThread(page, '100000000000002')).seenMessageId,
        ).toBeUndefined();
      } finally {
        await context.close();
      }
    });
    it('reads Facebook request previews without opening or accepting them', async () => {
      const { page, context, navigations } = await fixture((url) =>
        url === '/messages/requests/' ? requestsFixture : captured,
      );
      try {
        await page.goto('https://www.facebook.com/messages/requests/');
        await page.evaluate(() => {
          (window as unknown as { accepted: number }).accepted = 0;
          document.querySelector('button')!.addEventListener('click', () => {
            (window as unknown as { accepted: number }).accepted++;
          });
        });
        const result = await readFacebookRequestPreviews(page);
        expect(result.messages).toMatchObject([
          {
            externalMessageId: 'preview:900000000000071',
            threadId: '900000000000071',
            incomplete: true,
            incompleteReasonUk:
              'Запит не відкрито, щоб не позначати прочитаним.',
            peerProfile: 'https://www.facebook.com/900000000000072/',
          },
        ]);
        expect(result.skipped).toContain('requests_preview_only');
        expect(
          await page.evaluate(
            () => (window as unknown as { accepted: number }).accepted,
          ),
        ).toBe(0);
        expect(navigations).not.toContain('/messages/t/900000000000071/');
      } finally {
        await context.close();
      }
    });
    it('imports relative timestamps without inventing an occurrence date, commits chunks and never claims complete coverage', async () => {
      const html = captured
        .replaceAll('4 November 2026, 20:17', '01:08')
        .replaceAll('4 November 2026, 20:18', 'Saturday 16:45');
      const { page, context, navigations } = await fixture(html);
      const batches: SocialInboxBatch[] = [];
      try {
        const persist = vi.fn(async (batch: SocialInboxBatch) => {
          batches.push(batch);
        });
        const result = await captureFacebookInbox(
          page,
          '100000000000002',
          3000,
          persist,
        );
        expect(result).toMatchObject({
          complete: false,
          reason: 'unsupported_dom',
          skipped: [
            'pagination_unverified',
            'archived_folder_unverified',
            'requests_empty_or_unverified',
          ],
        });
        expect(persist).toHaveBeenCalledTimes(2);
        expect(batches[0]!.messages[2]).toMatchObject({
          occurredAt: null,
          providerTimestamp: '01:08',
          direction: 'in',
        });
        expect(batches[0]!.messages[3]).toMatchObject({
          occurredAt: null,
          providerTimestamp: 'Saturday 16:45',
        });
        expect(navigations).toEqual([
          path,
          '/messages/',
          path,
          '/messages/requests/',
        ]);
      } finally {
        await context.close();
      }
    });
    it.each(['id', 'peer', 'composer', 'content', 'group'] as const)(
      'rejects unverified %s without guessing identities or text',
      async (change) => {
        const { page, context } = await fixture();
        try {
          await page.evaluate((change) => {
            if (change === 'id')
              document
                .querySelectorAll('[data-message-id]')
                .forEach((n) => n.removeAttribute('data-message-id'));
            if (change === 'peer')
              document
                .querySelector('a[aria-label="Synthetic Recipient"]')!
                .setAttribute(
                  'href',
                  'https://attacker.invalid/100000000000001/',
                );
            if (change === 'composer')
              document
                .querySelector('[aria-label="Write to Synthetic Recipient"]')!
                .setAttribute('aria-label', 'Write to Other');
            if (change === 'content')
              document
                .querySelectorAll(
                  '[aria-roledescription="message"] div[dir="auto"]',
                )
                .forEach((n) => (n.textContent = 'different'));
            if (change === 'group')
              document
                .querySelectorAll('[aria-roledescription="message"]')
                .forEach((n) =>
                  n.setAttribute(
                    'aria-label',
                    'At 01:08, Third party: Synthetic incoming 1',
                  ),
                );
          }, change);
          const result = await readFacebookThread(page, '100000000000002');
          expect(result.messages).toEqual([]);
          expect(result.skipped.length).toBeGreaterThan(0);
        } finally {
          await context.close();
        }
      },
    );
    it.each([true, false])(
      'dismisses the restore flow only with proven modal semantics (%s)',
      async (proven) => {
        const restore = `<div id="pin" role="dialog" aria-modal="true"><button aria-label="Close" onclick="document.querySelector('#pin').remove();document.querySelector('#continuation').hidden=false">Close</button><h2>Enter your PIN to restore your chats</h2><p>Some messages are missing. Enter your PIN to restore your chat history.</p><input aria-label="PIN"><button>Forgotten PIN?</button></div><div id="continuation" role="dialog" aria-modal="true" hidden><h2>Continue without restoring?</h2><p>This means that you won’t see your full chat history on this device and new messages that you send or receive may not load on other new devices.</p><button>Cancel</button><button onclick="document.querySelector('#continuation').remove()">Don't restore messages</button></div>`;
        const { page, context } = await fixture(
          (proven
            ? restore
            : restore.replaceAll('role="dialog" aria-modal="true"', '')) +
            captured,
        );
        try {
          const persist = vi.fn();
          expect(
            await captureFacebookInbox(page, '100000000000002', 3000, persist),
          ).toMatchObject({ complete: false });
          expect(persist.mock.calls[0]![0].messages).toHaveLength(4);
          expect(await page.locator('#pin,#continuation').count()).toBe(
            proven ? 0 : 2,
          );
        } finally {
          await context.close();
        }
      },
    );
    it('reads a conversation by structure alone, in a language the code has never seen', async () => {
      const html =
        '<div role="main"><a href="/100000000000001/">Peer Name</a><div role="log" aria-live="polite" aria-label="zz Peer Name">' +
        '<div role="article"><div data-scope="messages_table" data-message-id="100000000000001@msgr.11" aria-label="O pjatnyci 23:12, Peer: \u00abHello\u00bb" aria-roledescription="zz"><div dir="auto">Hello</div></div></div>' +
        '<div role="article"><div data-message-id="100000000000002@msgr.12" aria-label="O pjatnyci 23:13, qq: \u00abAnswer\u00bb"><div dir="auto">Answer</div></div></div>' +
        '</div></div>';
      const { page, context } = await fixture(html);
      try {
        const result = await readFacebookThread(page, '100000000000002');
        expect(result.skipped).toEqual([]);
        expect(
          result.messages.map((m) => [m.direction, m.body, m.threadId]),
        ).toEqual([
          ['in', 'Hello', '900000000000001'],
          ['out', 'Answer', '900000000000001'],
        ]);
      } finally {
        await context.close();
      }
    });
    const pinDialog = (clean: boolean) =>
      `<div id="pin" role="dialog" aria-modal="true"><div role="button" aria-label="x"><svg></svg></div><h2>zz</h2><input autocomplete="one-time-code" maxlength="6"><div role="button">ff</div></div><div id="cont" role="dialog" aria-modal="true" hidden><h2>yy</h2><div role="button">aa</div><div role="button" onclick="document.querySelector('#cont').remove()">bb</div></div><script>document.querySelector('#pin input').addEventListener('input', (e) => { window.typed = e.target.value; if (${clean} && e.target.value === '123456') document.querySelector('#pin').remove(); });</script>`;
    it.each([
      { pin: '123456', clean: true },
      { pin: '654321', clean: false },
    ])(
      'fills the owner PIN once and pauses instead of choosing "do not restore" when it fails ($pin)',
      async ({ pin, clean }) => {
        vi.stubEnv('FACEBOOK_RESTORE_PIN', pin);
        const { page, context } = await fixture(pinDialog(clean) + captured);
        try {
          const run = captureFacebookInbox(
            page,
            '100000000000002',
            3000,
            vi.fn(),
          );
          if (clean) {
            await expect(run).resolves.toMatchObject({ complete: false });
            expect(await page.locator('#pin').count()).toBe(0);
          } else {
            await expect(run).rejects.toBeInstanceOf(SocialSessionCheckError);
            // The confirm dialog was never revealed or clicked.
            expect(await page.locator('#cont').count()).toBe(1);
          }
          expect(
            await page.evaluate(
              () => (window as never as { typed: string }).typed,
            ),
          ).toBe(pin);
        } finally {
          vi.unstubAllEnvs();
          await context.close();
        }
      },
    );
    const chats = (paths: string[]) =>
      `<section role="region" aria-label="Thread list"><table aria-label="Chats"><tr><td>${paths.map((p) => `<a href="${p}">Chat</a>`).join('')}</td></tr></table></section>`;
    it.each([
      {
        name: 'login final route',
        finalPath: '/login/?private=secret',
        html: '',
        reason: 'login_required',
        urlKind: 'login',
        login: 0,
      },
      {
        name: 'password in inbox',
        html: '<input type="password" value="secret">',
        reason: 'login_required',
        urlKind: 'inbox',
        login: 1,
      },
      {
        name: 'PIN password overlap',
        html: '<h2>Enter your PIN to restore your chats</h2><input type="password" aria-label="PIN">',
        reason: 'login_required',
        urlKind: 'inbox',
        login: 1,
        pinRestore: 1,
      },
      {
        name: 'checkpoint final route',
        finalPath: '/checkpoint/private/',
        html: '',
        reason: 'checkpoint',
        urlKind: 'checkpoint',
        login: 0,
      },
      {
        name: 'checkpoint marker',
        html: '<form action="/checkpoint/"><button>Continue</button></form><input type="password">',
        reason: 'checkpoint',
        urlKind: 'inbox',
        login: 1,
      },
      {
        name: 'captcha precedence',
        html: '<div data-testid="captcha">private</div><input type="password">',
        reason: 'captcha',
        urlKind: 'inbox',
        login: 1,
      },
      {
        name: 'unconfirmed PIN history',
        html: '<h2>Enter your PIN to restore your chats</h2><input aria-label="PIN"><button>Dismiss Chat history is missing card</button>',
        reason: 'unknown_auth',
        urlKind: 'inbox',
        login: 0,
        pinRestore: 1,
        historyMissing: 1,
      },
      {
        name: 'unconfirmed visible messages',
        html: captured,
        reason: 'unknown_auth',
        urlKind: 'inbox',
        login: 0,
        messageRegions: 1,
        messageNodes: 2,
      },
      {
        name: 'http failure',
        html: '',
        status: 403,
        reason: 'unknown_auth',
        urlKind: 'inbox',
        login: 0,
      },
      {
        name: 'rate limit',
        html: '',
        status: 429,
        reason: 'rate_limit',
        urlKind: 'inbox',
        login: 0,
      },
    ])(
      'captures only safe facts for $name without changing the guard',
      async (scenario) => {
        const { page, context } = await fixture();
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (
            route.request().method() !== 'GET' ||
            url.hostname !== 'www.facebook.com'
          )
            return route.abort();
          return route.fulfill({
            status: scenario.status ?? 200,
            contentType: 'text/html',
            // Model the final route without an HTTP redirect escaping routing.
            body: `<script>history.replaceState(null, '', ${JSON.stringify(scenario.finalPath ?? '/messages/')})</script>${scenario.html}`,
          });
        });
        const persist = vi.fn();
        try {
          const error = await captureFacebookInbox(
            page,
            '100000000000002',
            150,
            persist,
          ).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(SocialSessionCheckError);
          expect(error).toMatchObject({
            reason: scenario.reason,
            diagnostic: {
              version: 1,
              stage: scenario.status ? 'http' : 'auth',
              urlKind: scenario.urlKind,
              navigationHttpStatus: scenario.status ?? 200,
              visible: { login: scenario.login },
              history: {
                pinRestore: scenario.pinRestore ?? 0,
                historyMissing: scenario.historyMissing ?? 0,
                messageRegions: scenario.messageRegions ?? 0,
                messageNodes: scenario.messageNodes ?? 0,
              },
            },
          });
          const diagnostic = (error as SocialSessionCheckError).diagnostic;
          expect(safeSocialSessionDiagnostic(diagnostic)).toEqual(diagnostic);
          expect(JSON.stringify(diagnostic)).not.toMatch(
            /private|secret|https|100000|Synthetic|msgr|rawUrl/,
          );
          expect(persist).not.toHaveBeenCalled();
        } finally {
          await context.close();
        }
      },
    );
    it('captures a late thread logout before page closure', async () => {
      const { page, context } = await fixture((p) =>
        p === '/messages/' ? chats([path]) : '<input type="password">',
      );
      try {
        await expect(
          captureFacebookInbox(page, '100000000000002', 1000, vi.fn()),
        ).rejects.toMatchObject({
          reason: 'login_required',
          diagnostic: {
            stage: 'auth',
            urlKind: 'thread',
            navigationHttpStatus: 200,
            visible: { login: 1 },
          },
        });
      } finally {
        await context.close();
      }
    });
    it('preserves the original auth error when diagnostics cannot read a closed page', async () => {
      const { page, context } = await fixture();
      const error = new SocialSessionCheckError('checkpoint');
      try {
        await expect(
          captureFacebookInbox(
            page,
            '100000000000002',
            1000,
            vi.fn(),
            async () => {
              await page.close();
              throw error;
            },
          ),
        ).rejects.toBe(error);
        expect(error.diagnostic).toBeUndefined();
      } finally {
        await context.close();
      }
    });
    it('does not starve a readable second chat when the first stays empty across polls', async () => {
      const bad = '/messages/e2ee/t/900000000000099/';
      const { page, context, navigations } = await fixture((p) =>
        p === '/messages/'
          ? chats([bad, path])
          : p === bad
            ? '<div aria-label="Messages in conversation with Empty">No available messages</div>'
            : captured,
      );
      navigations.length = 0;
      page.setDefaultTimeout(300);
      try {
        const batches: SocialInboxBatch[] = [];
        for (let n = 0; n < 2; n++)
          await captureFacebookInbox(
            page,
            '100000000000002',
            350,
            async (b) => {
              batches.push(b);
            },
          );
        expect(navigations.filter((p) => p === path)).toHaveLength(2);
        expect(batches.flatMap((b) => b.messages)).toHaveLength(8);
      } finally {
        await context.close();
      }
    });
    it('resumes after exhausted chats so a later readable chat gets a useful budget on a later poll', async () => {
      const bad = Array.from(
        { length: 5 },
        (_, i) => `/messages/e2ee/t/90000000000009${i}/`,
      );
      const { page, context, navigations } = await fixture((p) =>
        p === '/messages/'
          ? chats([...bad, path])
          : p === path
            ? captured
            : '<div aria-label="Messages in conversation with Empty">No available messages</div>',
      );
      navigations.length = 0;
      page.setDefaultTimeout(300);
      try {
        let anchor: Record<string, unknown> | null = null;
        const messages: SocialInboxBatch['messages'] = [];
        for (let poll = 0; poll < 4 && !messages.length; poll++) {
          await captureFacebookInbox(
            page,
            '100000000000002',
            350,
            async (batch) => {
              anchor = batch.resumeAnchor;
              messages.push(...batch.messages);
            },
            undefined,
            anchor,
          );
        }
        expect(navigations).toContain(path);
        expect(messages).toHaveLength(4);
      } finally {
        await context.close();
      }
    });
    it('never climbs from a PIN section into a page wrapper to click another Close', async () => {
      const pin =
        '<section id="pin"><h2>Enter your PIN to restore your chats</h2><p>Some messages are missing. Enter your PIN to restore your chat history.</p><input aria-label="PIN"><button>Forgotten PIN?</button></section>';
      const other =
        '<aside><button aria-label="Close" onclick="window.recordClose();document.body.dataset.unrelatedClicked=\'yes\'">Close</button></aside>';
      const { page, context } = await fixture((p) =>
        p === '/messages/'
          ? `<main>${other}${pin}${chats([path])}</main>`
          : captured,
      );
      page.setDefaultTimeout(300);
      let unrelatedClicks = 0;
      await context.exposeBinding('recordClose', () => {
        unrelatedClicks++;
      });
      try {
        await captureFacebookInbox(
          page,
          '100000000000002',
          1000,
          async () => {},
        ).catch(() => {});
        expect(unrelatedClicks).toBe(0);
        expect(
          await page.locator('body').getAttribute('data-unrelated-clicked'),
        ).toBeNull();
      } finally {
        await context.close();
      }
    });
    it('stops on a checkpoint without persisting messages or interacting with the composer', async () => {
      const { page, context } = await fixture();
      try {
        const persist = vi.fn();
        await expect(
          captureFacebookInbox(
            page,
            '100000000000002',
            3000,
            persist,
            async () => {
              throw new Error('checkpoint');
            },
          ),
        ).rejects.toThrow('checkpoint');
        expect(persist).not.toHaveBeenCalled();
      } finally {
        await context.close();
      }
    });
  },
);
