import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { socialTarget } from '@sonar/core';
import { registerHotPage } from './facebook-hot-page.js';
import { sendFacebookHot } from './facebook-hot-send.js';

const captured = readFileSync(
  new URL('./facebook-chat.sanitized.fixture.html', import.meta.url),
  'utf8',
).replace(
  /data-message-id="synthetic-id-(\d+)"/g,
  'data-message-id="100000000000001@msgr.$1"',
);
const thread = '/messages/e2ee/t/900000000000001/';
// Enter appends a copy of the last outgoing bubble with the typed text, as
// Messenger does once the server has accepted the message.
const sender = `<script>
document.querySelector('[data-lexical-editor]').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = e.target.innerText.trim();
  const outgoing = [...document.querySelectorAll('[role=article]')].filter((a) =>
    /You:/.test(a.querySelector('[aria-label]')?.getAttribute('aria-label') ?? ''));
  const last = outgoing[outgoing.length - 1];
  const copy = last.cloneNode(true);
  const row = copy.querySelector('[data-message-id]');
  row.setAttribute('data-message-id', '100000000000001@msgr.99');
  row.setAttribute('aria-label', 'At 4 November 2026, 20:20, You: ' + text);
  copy.querySelector('div[dir=auto]').textContent = text;
  last.parentElement.appendChild(copy);
  e.target.innerHTML = '<p dir="auto"><br></p>';
});
</script>`;
const target = socialTarget('https://www.facebook.com/100000000000001/')!;

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Facebook hot-page send',
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
    async function fixture(accepts: boolean) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'www.facebook.com') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body:
            url.pathname === '/messages/'
              ? `<a aria-label="Your profile">Profile</a><table><tbody><tr><td><a href="${thread}">Synthetic Recipient</a></td></tr></tbody></table>`
              : `<a aria-label="Your profile">Profile</a>${captured}${accepts ? sender : ''}`,
        });
      });
      const page = await context.newPage();
      await page.goto('https://www.facebook.com/messages/');
      const hot = registerHotPage('account', page);
      const calls: string[] = [];
      const input = {
        target,
        threadId: '900000000000001',
        body: 'Hot message',
        ownId: '100000000000002',
        timeoutMs: 5000,
        confirmMs: 1200,
        beforeFill: vi.fn(async () => {
          calls.push('fill');
        }),
        beforeSend: vi.fn(async () => {
          calls.push('send');
        }),
        assertSession: vi.fn(async () => {}),
      };
      return { context, hot, input, calls };
    }
    it('opens the known chat in the open page and confirms the new outgoing row', async () => {
      const { context, hot, input, calls } = await fixture(true);
      try {
        const result = await sendFacebookHot(hot, input);
        expect(result).toMatchObject({
          outcome: 'facebook_dispatched_unconfirmed',
          externalMessageId: '100000000000001@msgr.99',
          threadId: '900000000000001',
          dialogUrl: target.canonicalUrl,
          observation: { newOutgoing: true, dispatchPerformed: true },
        });
        expect(calls).toEqual(['fill', 'send']);
        expect(hot.pendingSends).toBe(0);
        expect(hot.activeOps).toBe(0);
      } finally {
        await context.close();
      }
    });
    it('reports uncertainty, never a retry, when the message does not appear', async () => {
      const { context, hot, input } = await fixture(false);
      try {
        await expect(sendFacebookHot(hot, input)).rejects.toMatchObject({
          code: 'delivery_uncertain',
        });
        expect(input.beforeSend).toHaveBeenCalledOnce();
      } finally {
        await context.close();
      }
    });
    it('declines an unknown chat or another recipient without touching anything', async () => {
      const { context, hot, input } = await fixture(true);
      try {
        expect(
          await sendFacebookHot(hot, { ...input, threadId: '900000000000777' }),
        ).toBeNull();
        expect(
          await sendFacebookHot(hot, {
            ...input,
            target: socialTarget('https://www.facebook.com/100000000000009/')!,
          }),
        ).toBeNull();
        expect(input.beforeFill).not.toHaveBeenCalled();
        expect(input.beforeSend).not.toHaveBeenCalled();
      } finally {
        await context.close();
      }
    });
  },
);
