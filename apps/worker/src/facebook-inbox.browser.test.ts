import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  captureFacebookInbox,
  readFacebookThread,
} from './facebook-inbox-browser.js';
import type { SocialInboxBatch } from '@sonar/core/social-inbox';

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
    async function fixture(html = captured) {
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
            url.pathname === '/messages/'
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
            'requests_and_archived_unverified',
          ],
        });
        expect(persist).toHaveBeenCalledOnce();
        expect(batches[0]!.messages[2]).toMatchObject({
          occurredAt: null,
          providerTimestamp: '01:08',
          direction: 'in',
        });
        expect(batches[0]!.messages[3]).toMatchObject({
          occurredAt: null,
          providerTimestamp: 'Saturday 16:45',
        });
        expect(navigations).toEqual([path, '/messages/', path]);
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
    it('dismisses only the exact observed non-destructive restore flow even without a dialog role', async () => {
      const restore = `<div id="pin"><button aria-label="Close" onclick="document.querySelector('#pin').remove();document.querySelector('#continuation').hidden=false">Close</button><h2>Enter your PIN to restore your chats</h2><p>Some messages are missing. Enter your PIN to restore your chat history.</p><input aria-label="PIN"><button>Forgotten PIN?</button></div><div id="continuation" hidden><h2>Continue without restoring?</h2><p>This means that you won’t see your full chat history on this device and new messages that you send or receive may not load on other new devices.</p><button>Cancel</button><button onclick="document.querySelector('#continuation').remove()">Don't restore messages</button></div>`;
      const { page, context } = await fixture(restore + captured);
      try {
        const persist = vi.fn();
        expect(
          await captureFacebookInbox(page, '100000000000002', 3000, persist),
        ).toMatchObject({ complete: false });
        expect(persist.mock.calls[0]![0].messages).toHaveLength(4);
        expect(await page.locator('#pin,#continuation').count()).toBe(0);
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
