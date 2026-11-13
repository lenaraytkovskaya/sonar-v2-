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
    const capturedMenu = readFileSync(
      new URL('./instagram-menu.sanitized.fixture.html', import.meta.url),
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
        if (
          url.pathname === '/api/v1/direct/fixture/' ||
          url.pathname === '/blocked-resource'
        )
          return route.fulfill({
            status: Number(options.backgroundStatus ?? 429),
            body: '{}',
          });
        if (options.navigationFailure) return route.abort('failed');
        if (
          url.hostname === 'www.instagram.com' &&
          url.pathname === '/fixture_company/'
        )
          return route.fulfill({
            status: options.rateLimit ? 429 : 200,
            contentType: 'text/html',
            body: options.capturedMenu
              ? capturedMenu + '<nav><a href="/direct/inbox/">Inbox</a></nav>'
              : html,
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
        if (options.switchComposer)
          await page.evaluate(() => {
            const original = document.querySelector('[contenteditable]')!;
            const other = original.cloneNode(true) as HTMLElement;
            other.onkeydown = () => {
              void (
                window as unknown as {
                  fixtureEvent: (event: string) => Promise<void>;
                }
              ).fixtureEvent('send:other_person');
            };
            original.replaceWith(other);
          });
        if (options.switchContainer)
          await page.evaluate(
            'document.querySelector("main").replaceWith(document.querySelector("main").cloneNode(true))',
          );
        if (options.hideRecipient)
          await page.evaluate(
            'document.querySelector("main header a").hidden = true',
          );
        if (options.switchRecipient)
          await page.evaluate(
            'document.querySelector("main header a").href = "/other/"',
          );
        if (options.markerRateLimit)
          await page.evaluate(
            'fetch("/api/v1/direct/fixture/").then(response => response.status)',
          );
        if (options.backgroundStatus)
          await page.evaluate(
            async ({ image, relevant }) => {
              const url = relevant
                ? '/api/v1/direct/fixture/'
                : '/blocked-resource';
              if (!image) return fetch(url).then((response) => response.status);
              await new Promise((resolve) => {
                const resource = new Image();
                resource.onload = resource.onerror = resolve;
                resource.src = 'https://unrelated.fixture.test' + url;
              });
            },
            {
              image: Boolean(options.backgroundImage),
              relevant: Boolean(options.relevantResponse),
            },
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
      { outerDialog: true },
      { innerDialog: true },
      { outerMain: true },
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
    it.each([
      {},
      { menuDialog: true },
      { menuItem: true },
      { menuLink: true },
      { directAvailable: true },
    ])('uses the profile overflow portal safely (%j)', async (options) => {
      const f = await fixture({ overflow: true, ...options });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.events).toEqual([
          ...('directAvailable' in options ? [] : ['options']),
          'open',
          'mark',
          'send',
        ]);
        expect(f.inputs).toEqual(['textbox']);
        expect(f.mark).toHaveBeenCalledOnce();
        expect(f.requests).toEqual(['www.instagram.com/fixture_company/']);
      } finally {
        await f.close();
      }
    });
    it.each([
      ['wrongOptionsScope', 'messagebutton'],
      ['unknownOptions', 'messagebutton'],
      ['duplicateOptions', 'messagebutton'],
      ['existingMenu', 'messagebutton'],
      ['wrongMenu', 'messagebutton'],
      ['duplicateMenu', 'messagebutton'],
      ['duplicateMenuAction', 'messagebutton'],
      ['noMenuMessage', 'messagebutton'],
      ['menuProfileMismatch', 'messagebutton'],
      ['wrongRecipient', 'dialog'],
      ['groupRecipient', 'dialog'],
    ])('refuses unsafe overflow route %s', async (option, stage) => {
      const f = await fixture({ overflow: true, [option!]: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'unavailable',
          stage,
        });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
        expect(f.events).toEqual(
          [
            'wrongOptionsScope',
            'unknownOptions',
            'duplicateOptions',
            'existingMenu',
          ].includes(option!)
            ? []
            : ['wrongRecipient', 'groupRecipient'].includes(option!)
              ? ['options', 'open']
              : ['options'],
        );
      } finally {
        await f.close();
      }
    });
    it('recognizes the captured role-button ancestors and keeps an already open menu blocked', async () => {
      const f = await fixture({ capturedMenu: true });
      try {
        const page = await f.context.newPage();
        await page.goto('https://www.instagram.com/fixture_company/');
        const profile = page.locator('main header, [role="main"] header');
        const options = profile.getByRole('button', { name: /^Параметри$/ });
        expect(await profile.count()).toBe(1);
        expect(await options.count()).toBe(1);
        expect(await options.ariaSnapshot()).toContain('button "Параметри"');
        const popup = page.locator(
          '[role="menu"]:visible, [role="dialog"]:visible',
        );
        expect(await popup.count()).toBe(1);
        expect(
          await popup
            .getByRole('button', { name: /^Надіслати повідомлення$/ })
            .count(),
        ).toBe(1);
        await page.locator('[role="dialog"]').evaluate((node: HTMLElement) => {
          node.hidden = true;
        });
        expect(await popup.count()).toBe(0);
        expect(await options.count()).toBe(1);
        // send() navigates a fresh page to the captured OPEN menu again.
        await expect(f.send()).rejects.toMatchObject({
          stage: 'messagebutton',
          errorKind: 'unconfirmed',
          reasonUk: expect.stringContaining(
            '[branch=preexisting_popup; menus=0; dialogs=1; options=1]',
          ),
        });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
        expect(f.events).toEqual([]);
        expect(f.requests).toEqual(
          Array(2).fill('www.instagram.com/fixture_company/'),
        );
      } finally {
        await f.close();
      }
    });
    it.each([
      [
        'existingMenu',
        '[branch=preexisting_popup; menus=1; dialogs=0; options=1]',
      ],
      [
        'outerDialog',
        '[branch=preexisting_popup; menus=0; dialogs=1; options=1]',
      ],
      [
        'duplicateOptions',
        '[branch=options_count; menus=0; dialogs=0; options=2+]',
      ],
    ])(
      'distinguishes the safe refusal for %s without page content',
      async (option, detail) => {
        const f = await fixture({ overflow: true, [option!]: true });
        try {
          const error = await f.send().catch((error) => error);
          expect(error).toMatchObject({
            code: 'unavailable',
            stage: 'messagebutton',
            errorKind: 'unconfirmed',
            reasonUk: expect.stringContaining(detail!),
          });
          expect(error.message).toBe(error.reasonUk);
          expect(error.reasonUk).not.toMatch(
            /fixture_company|Synthetic message|https:|cookie/i,
          );
          expect(f.events).toEqual([]);
          expect(f.inputs).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it.each(['switchRecipient', 'switchComposer', 'markerRateLimit'])(
      'preserves the durable attempt and session gates after overflow (%s)',
      async (option) => {
        const f = await fixture({ overflow: true, [option]: true });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code:
              option === 'markerRateLimit'
                ? 'rate_limit'
                : 'delivery_uncertain',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['options', 'open', 'mark']);
        } finally {
          await f.close();
        }
      },
    );
    it('stops on a rate limit while opening the profile options', async () => {
      const f = await fixture({ overflow: true, menuRateLimit: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'rate_limit',
          stage: 'session',
        });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.events).toEqual(['options']);
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
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
        await expect.poll(() => f.inputs).toEqual(['decoy']);
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
      ['domRateLimit', 'session', 'restricted', 'rate_limit'],
      ['rateLimit', 'navigation', 'http_429', 'rate_limit'],
      ['wrongProfile', 'profile', 'timeout', 'unavailable'],
      ['noMessage', 'messagebutton', 'timeout', 'unavailable'],
      ['noDialog', 'dialog', 'timeout', 'unavailable'],
      ['wrongRecipient', 'dialog', 'timeout', 'unavailable'],
      ['sidebarOnlyRecipient', 'dialog', 'timeout', 'unavailable'],
      ['groupRecipient', 'dialog', 'mismatch', 'unavailable'],
      ['splitPane', 'dialog', 'timeout', 'unavailable'],
      ['hiddenRecipient', 'dialog', 'timeout', 'unavailable'],
      ['staleHeader', 'dialog', 'unconfirmed', 'unavailable'],
      ['ambiguousDialog', 'dialog', 'unconfirmed', 'unavailable'],
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
    it.each([
      'markerFailure',
      'switchRecipient',
      'switchContainer',
      'switchComposer',
      'hideRecipient',
    ])(
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
    it.each(
      [401, 403, 429].flatMap((backgroundStatus) =>
        [false, true].map((backgroundImage) => ({
          backgroundStatus,
          backgroundImage,
        })),
      ),
    )(
      'ignores unrelated background response %j',
      async ({ backgroundStatus, backgroundImage }) => {
        const f = await fixture({ backgroundStatus, backgroundImage });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'mark', 'send']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([401, 403, 429])(
      'stops for relevant direct API HTTP %s',
      async (backgroundStatus) => {
        const f = await fixture({ backgroundStatus, relevantResponse: true });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: backgroundStatus === 429 ? 'rate_limit' : 'session_invalid',
            stage: 'session',
            errorKind: backgroundStatus === 429 ? 'http_429' : 'restricted',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'mark']);
        } finally {
          await f.close();
        }
      },
    );
    it('stops at a locally simulated HTTP 429 during the durable marker without sending', async () => {
      const f = await fixture({ markerRateLimit: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'rate_limit',
          stage: 'session',
          errorKind: 'http_429',
        });
        expect(f.mark).toHaveBeenCalledOnce();
        expect(f.events).toEqual(['open', 'mark']);
      } finally {
        await f.close();
      }
    });
  },
);
