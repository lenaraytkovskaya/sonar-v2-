import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createSocialSendBrowser } from './social-send-browser.js';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Instagram local HTML route',
  () => {
    let browser: Browser;
    const html = readFileSync(
      new URL('./instagram-send.fixture.html', import.meta.url),
      'utf8',
    );
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
    async function fixture(options: Record<string, unknown> = {}) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let page: Page;
      context.on('page', (value) => {
        page = value;
      });
      const requests: string[] = [];
      const events: string[] = [];
      const inputs: string[] = [];
      await context.exposeBinding('fixtureEvent', (_source, value: string) => {
        events.push(value);
      });
      await context.exposeBinding('fixtureInput', (_source, value: string) => {
        inputs.push(value);
      });
      await context.addInitScript({
        content: `window.fixtureOptions = ${JSON.stringify(options)}; document.addEventListener('input', event => window.fixtureInput(event.target.id || event.target.getAttribute('role') || event.target.tagName.toLowerCase()));`,
      });
      // Every request is fulfilled or aborted locally; DNS is also disabled at launch.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        requests.push(`${url.hostname}${url.pathname}`);
        if (url.pathname === '/fixture-rate-limit')
          return route.fulfill({ status: 429, body: '{}' });
        if (options.navigationFailure) return route.abort('failed');
        if (
          url.hostname === 'www.instagram.com' &&
          url.pathname === '/fixture_company/'
        )
          return route.fulfill({
            status: options.rateLimit ? 429 : 200,
            contentType: 'text/html',
            body: html,
          });
        if (url.hostname !== 'ig.me') return route.abort('blockedbyclient');
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<p>Deep link cannot open this chat</p>',
        });
      });
      const adapter = createSocialSendBrowser(
        async () => ({ newContext: async () => context }) as unknown as Browser,
      );
      const mark = vi.fn(async () => {
        if (options.markerFailure)
          throw Error(
            'https://user:synthetic-password@example.test/ cookie=synthetic-cookie Synthetic message',
          );
        if (options.switchRecipient)
          await page.evaluate(
            'document.querySelector("main header a").href = "/other/"',
          );
        if (options.markerRateLimit)
          await page.evaluate(
            'fetch("/fixture-rate-limit").then(response => response.status)',
          );
        events.push('mark');
      });
      const send = () =>
        adapter.send(
          { id: 'fixture', channel: 'instagram', settings: {} },
          { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
          250,
          'https://instagram.com/fixture_company/',
          typeof options.body === 'string' ? options.body : 'Synthetic message',
          mark,
        );
      return {
        send,
        mark,
        requests,
        events,
        inputs,
        context,
        close: () => context.close(),
      };
    }
    it.each([
      {},
      { messageLink: true },
      { delayedDialog: true },
      { textarea: true },
      { body: 'Try again later' },
    ])(
      'opens the profile action, confirms its recipient, ignores an unrelated last textbox and sends once (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.requests).toEqual(['www.instagram.com/fixture_company/']);
          expect(f.events).toEqual(['open', 'mark', 'send']);
          expect(f.inputs).toEqual([
            'textarea' in options ? 'textarea' : 'textbox',
          ]);
          expect(f.mark).toHaveBeenCalledOnce();
        } finally {
          await f.close();
        }
      },
    );
    it('reproduces why the former generic last textbox is unsafe on an actual DOM', async () => {
      const f = await fixture();
      try {
        const page = await f.context.newPage();
        await page.goto('https://www.instagram.com/fixture_company/');
        await page.getByRole('button', { name: 'Повідомлення' }).click();
        const formerComposer = page
          .locator(
            '[contenteditable="true"][role="textbox"], textarea[placeholder]',
          )
          .last();
        expect(await formerComposer.getAttribute('id')).toBe('decoy');
        await formerComposer.fill('Synthetic message');
        expect(f.events).toEqual(['open']);
        expect(f.inputs).toEqual(['decoy']);
      } finally {
        await f.close();
      }
    });
    it.each([
      ['navigationFailure', 'navigation', 'unexpected', 'unavailable'],
      ['login', 'session', 'unconfirmed', 'session_invalid'],
      ['captcha', 'session', 'unconfirmed', 'session_invalid'],
      ['checkpoint', 'session', 'unconfirmed', 'session_invalid'],
      ['noSession', 'session', 'timeout', 'session_invalid'],
      ['domRateLimit', 'session', 'restricted', 'session_invalid'],
      ['rateLimit', 'navigation', 'http_429', 'session_invalid'],
      ['wrongProfile', 'profile', 'timeout', 'unavailable'],
      ['noMessage', 'messagebutton', 'timeout', 'unavailable'],
      ['noDialog', 'dialog', 'timeout', 'unavailable'],
      ['wrongRecipient', 'dialog', 'timeout', 'unavailable'],
      ['sidebarOnlyRecipient', 'dialog', 'timeout', 'unavailable'],
      ['groupRecipient', 'dialog', 'mismatch', 'unavailable'],
      ['noComposer', 'composer', 'timeout', 'unavailable'],
      ['duplicateComposer', 'composer', 'unexpected', 'unavailable'],
    ])(
      'stops safely for %s with a stage-specific reason',
      async (option, stage, errorKind, code) => {
        const f = await fixture({ [option!]: true });
        try {
          await expect(f.send()).rejects.toMatchObject({
            stage,
            errorKind,
            code,
            reasonUk: expect.stringContaining(`[${stage}/${errorKind}]`),
          });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events).not.toContain('send');
        } finally {
          await f.close();
        }
      },
    );
    it.each(['noConfirmation', 'postLogin', 'existingMessage'])(
      'never retries after a durable attempt with %s',
      async (option) => {
        const f = await fixture({ [option]: true, noConfirmation: true });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code:
              option === 'postLogin' ? 'session_invalid' : 'delivery_uncertain',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'mark', 'send']);
        } finally {
          await f.close();
        }
      },
    );
    it.each(['markerFailure', 'switchRecipient'])(
      'does not send when %s occurs during the durable marker',
      async (option) => {
        const f = await fixture({ [option]: true });
        try {
          const error = await f.send().catch((error) => error);
          expect(error).toMatchObject({
            code: 'delivery_uncertain',
            stage: option === 'markerFailure' ? 'attempt' : 'dialog',
          });
          expect(error.reasonUk).not.toMatch(
            /synthetic-password|synthetic-cookie|Synthetic message|https:/,
          );
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(
            option === 'markerFailure' ? ['open'] : ['open', 'mark'],
          );
        } finally {
          await f.close();
        }
      },
    );
    it('stops at a locally simulated HTTP 429 during the durable marker without sending', async () => {
      const f = await fixture({ markerRateLimit: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'session_invalid',
          stage: 'session',
          errorKind: 'restricted',
        });
        expect(f.mark).toHaveBeenCalledOnce();
        expect(f.events).toEqual(['open', 'mark']);
      } finally {
        await f.close();
      }
    });
  },
);
