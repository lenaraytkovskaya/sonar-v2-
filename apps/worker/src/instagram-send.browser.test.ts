import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
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
    const startup = readFileSync(
      new URL('./instagram-startup.sanitized.fixture.html', import.meta.url),
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
        if (options.directClickFailure || options.directClickBlocked) {
          const locate = page.locator.bind(page);
          const links = locate('nav a');
          const click = links.click.bind(links);
          vi.spyOn(links, 'click').mockImplementation(async (clickOptions) => {
            await page.evaluate(() => {
              document.body.insertAdjacentHTML(
                'beforeend',
                '<div id="splash-screen" style="position:fixed;inset:0;background:white;z-index:10">Instagram</div>',
              );
            });
            if (options.directClickBlocked) return click(clickOptions);
            throw new Error(
              'Element is not attached to the DOM https://private.invalid/account-id private text',
            );
          });
          vi.spyOn(page, 'locator').mockImplementation(
            (selector, locatorOptions) =>
              selector.startsWith(':is(nav')
                ? ({ filter: () => links } as unknown as Locator)
                : locate(selector, locatorOptions),
          );
        }
      });
      const labels = {
        en: ['Turn on Notifications', 'Turn On', 'Not Now'],
        uk: ['Увімкнути сповіщення', 'Увімкнути', 'Не зараз'],
        ru: ['Включить уведомления', 'Включить', 'Не сейчас'],
      };
      const language = options.notificationLanguage as keyof typeof labels;
      let startupMarkup = language
        ? startup
            .replace('{{heading}}', labels[language][0]!)
            .replace('{{enable}}', labels[language][1]!)
            .replace('{{dismiss}}', labels[language][2]!)
        : '';
      if (options.unknownNotifications)
        startupMarkup = startupMarkup.replace(
          labels[language][0]!,
          'Unknown fixture heading',
        );
      if (options.extraNotificationAction)
        startupMarkup = startupMarkup.replace(
          /<\/div>\s*$/,
          '<button>Other action</button></div>',
        );
      if (options.duplicateNotifications) startupMarkup += startupMarkup;
      if (options.replaceNotifications)
        startupMarkup += `<script>document.querySelector('[role="dialog"] button:last-child').addEventListener('pointerover', () => { const old = document.querySelector('[role="dialog"]'); const next = old.cloneNode(true); next.querySelector('h2').textContent = 'Unknown fixture heading'; old.replaceWith(next); }, { once: true });</script>`;
      if (options.mutateNotifications)
        startupMarkup += `<script>document.querySelector('[role="dialog"] button:last-child').addEventListener('pointerover', () => { document.querySelector('[role="dialog"] h2').textContent = 'Unknown fixture heading'; }, { once: true });</script>`;
      const requests: string[] = [];
      let directBooted = false;
      const events: string[] = [];
      const inputs: string[] = [];
      await context.exposeBinding('fixtureEvent', (_source, value: string) => {
        events.push(value);
      });
      await context.exposeBinding('fixtureInput', (_source, value: string) => {
        inputs.push(value);
      });
      await context.addInitScript({
        content: `window.fixtureOptions = ${JSON.stringify({ ...options, sanitizedMarkup: options.sanitizedMenu ? capturedMenu : undefined })}; document.addEventListener('input', event => window.fixtureInput(event.target.id || event.target.getAttribute('role') || event.target.tagName.toLowerCase()));`,
      });
      // Every request is fulfilled or aborted locally; DNS is also disabled at launch.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        requests.push(`${url.hostname}${url.pathname}`);
        if (url.pathname === '/stalled-script') return;
        if (
          url.pathname === '/api/v1/direct/fixture/' ||
          url.pathname === '/blocked-resource'
        )
          return route.fulfill({
            status: Number(options.backgroundStatus ?? 429),
            body: '{}',
          });
        if (options.navigationFailure) return route.abort('failed');
        if (url.pathname === '/failed-script')
          return route.abort('connectionrefused');
        if (options.recoverViaHome && url.pathname === '/api/graphql')
          return route.fulfill({
            status: Number(
              options.homeGraphqlStatus ??
                (directBooted ? options.resumedGraphqlStatus : 200) ??
                200,
            ),
            contentType: 'application/json',
            body: '{}',
          });
        if (options.recoveredCheckpoint && url.pathname === '/challenge/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<main>Confirm identity</main>',
          });
        if (options.recoverViaHome && url.hostname === 'www.instagram.com') {
          if (url.pathname === '/')
            return route.fulfill({
              contentType: 'text/html',
              body:
                startupMarkup +
                ((options.homeMarkup as string) ||
                  `<main>${options.homeLogin ? '<input type="password">' : ''}<nav ${options.homeGraphqlStatus ? 'hidden' : ''}>${options.homeDirectLinks ?? '<a href="/direct/inbox/">Messages</a>'}</nav></main>${options.homeGraphqlStatus ? '<script>fetch("/api/graphql", {method: "POST"}).then(() => document.querySelector("nav").hidden = false)</script>' : ''}${options.homeCheckpoint ? '<script>history.replaceState({}, "", "/challenge/")</script>' : ''}`),
            });
          if (/^\/direct\/inbox\/?$/.test(url.pathname)) {
            directBooted = true;
            return route.fulfill({
              status: Number(options.recoveredDirectStatus ?? 200),
              contentType: 'text/html',
              body: options.recoveredCheckpoint
                ? '<script>location.replace("/challenge/")</script>'
                : startupMarkup +
                  '<main><a href="/direct/inbox/">Messages</a></main>',
            });
          }
        }
        if (
          options.directThreadRedirect &&
          url.pathname === '/direct/t/fixture-thread/'
        )
          directBooted = true;
        if (
          url.hostname === 'www.instagram.com' &&
          (url.pathname === '/' ||
            url.pathname === '/fixture_company/' ||
            url.pathname === '/direct/t/fixture-thread/')
        )
          return route.fulfill({
            status: options.rateLimit ? 429 : 200,
            contentType: 'text/html',
            body:
              options.splash ||
              (options.recoverViaHome && !directBooted) ||
              (options.splashOnFirstLoad &&
                requests.filter(
                  (request) => request === `${url.hostname}${url.pathname}`,
                ).length === 1) ||
              (options.delayedSplash && !url.searchParams.has('loaded'))
                ? `<main ${options.splashShell ? '' : 'hidden'}></main><div id="splash-screen" style="position:fixed;inset:0;background:white;z-index:10"><div aria-label="Instagram logo">Instagram</div><p>from Meta</p></div>${options.failedScript ? '<script src="/failed-script"></script>' : ''}${options.stalledNavigation ? '<script defer src="/stalled-script"></script>' : ''}${options.delayedSplash ? '<script>setTimeout(() => location.replace("/fixture_company/?loaded=1"), 60)</script>' : ''}`
                : options.capturedMenu
                  ? capturedMenu +
                    '<nav><a href="/direct/inbox/">Inbox</a></nav>'
                  : options.resumedGraphqlStatus && directBooted
                    ? html.replace('<nav>', '<nav hidden>') +
                      '<script>fetch("/api/graphql", {method:"POST"}).then(() => document.querySelector("nav").hidden = false)</script>'
                    : startupMarkup + html,
          });
        if (url.hostname !== 'ig.me') return route.abort('blockedbyclient');
        if (options.deepLinkSuccess)
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<script>location.href="https://www.instagram.com/direct/t/fixture-thread/"</script>',
          });
        if (options.splashDeepLink)
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<div aria-label="Instagram logo">Instagram</div><p>from Meta</p><script>location.replace("https://www.instagram.com/direct/t/fixture-thread/")</script>',
          });
        if (options.splashAtDeepLink)
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<div id="splash-screen" style="position:fixed;inset:0;background:white;z-index:10"><div aria-label="Instagram logo">Instagram</div><p>from Meta</p></div>',
          });
        return route.fulfill({
          status: 404,
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
        if (options.inboxMarkerAmbiguity)
          await page.evaluate(() => {
            const composer = document.querySelector('#chat-composer')!;
            composer.after(composer.cloneNode(true));
          });
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
            'document.querySelector("main :is(header, [data-pagelet=IGDInboxHeaderOffMsys]) a").hidden = true',
          );
        if (options.switchRecipient)
          await page.evaluate(
            'document.querySelector("main :is(header, [data-pagelet=IGDInboxHeaderOffMsys]) a").href = "/other/"',
          );
        if (options.mismatchPhase === 'after_marker')
          await page.evaluate(
            'document.dispatchEvent(new Event("fixture-marker"))',
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
      const persistFailureShot = vi.fn<
        (kind: string, shot: Record<string, unknown>) => Promise<void>
      >(async () => {});
      const send = () =>
        adapter.send(
          {
            id: 'fixture',
            channel: 'instagram',
            settings: options.knownThreadId
              ? { providerThreadId: options.knownThreadId }
              : {},
          },
          {
            cookies: [],
            proxy: { server: 'http://127.0.0.1:9' },
            persistFailureShot,
          },
          Number(options.timeoutMs ?? 250),
          'https://instagram.com/fixture_company/',
          typeof options.body === 'string' ? options.body : 'Synthetic message',
          mark,
          options.priorBodies
            ? {
                previousBodies: options.priorBodies as string[],
                beforeFill: async () => {},
              }
            : undefined,
        );
      return {
        send,
        check: () =>
          adapter.check(
            { id: 'fixture', channel: 'instagram', settings: {} },
            { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
            Number(options.timeoutMs ?? 250),
          ),
        keepalive: () =>
          adapter.keepalive(
            { id: 'fixture', channel: 'instagram', settings: {} },
            { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
            Number(options.timeoutMs ?? 250),
            0,
          ),
        mark,
        requests,
        events,
        inputs,
        persistFailureShot,
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
          expect(f.requests).toEqual([
            'ig.me/m/fixture_company',
            'www.instagram.com/fixture_company/',
          ]);
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
    it.each(['en', 'uk', 'ru'])(
      'dismisses only known %s notifications over loaded logo/footer and sends once',
      async (notificationLanguage) => {
        const f = await fixture({ notificationLanguage, timeoutMs: 180 });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.events).toEqual([
            'notifications-dismissed',
            'open',
            'mark',
            'send',
          ]);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.requests).not.toContain('www.instagram.com/');
          expect(f.persistFailureShot).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it('dismisses notifications before Direct recovery, inbox and resumed profile', async () => {
      const f = await fixture({
        recoverViaHome: true,
        notificationLanguage: 'en',
        timeoutMs: 180,
      });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.requests).toContain('www.instagram.com/direct/inbox/');
        expect(f.events).toEqual([
          'notifications-dismissed',
          'notifications-dismissed',
          'notifications-dismissed',
          'open',
          'mark',
          'send',
        ]);
        expect(f.mark).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });
    it.each([
      'unknownNotifications',
      'extraNotificationAction',
      'duplicateNotifications',
      'replaceNotifications',
      'mutateNotifications',
    ])(
      'preserves unconfirmed notifications (%s), captures diagnostics and stops before the marker',
      async (variant) => {
        const f = await fixture({
          notificationLanguage: 'en',
          [variant]: true,
          timeoutMs: 180,
        });
        try {
          const error = await f.send().catch((error) => error);
          expect(error).toMatchObject({
            stage: ['replaceNotifications', 'mutateNotifications'].includes(
              variant,
            )
              ? 'initial_wait'
              : 'messagebutton',
            errorKind: ['replaceNotifications', 'mutateNotifications'].includes(
              variant,
            )
              ? 'unconfirmed'
              : 'timeout',
          });
          expect(error.reasonUk).not.toContain('Unknown fixture heading');
          expect(f.events).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.inputs).toEqual([]);
          expect(f.persistFailureShot).toHaveBeenCalledWith(
            'send',
            expect.objectContaining({
              stage: ['replaceNotifications', 'mutateNotifications'].includes(
                variant,
              )
                ? 'initial_wait'
                : 'messagebutton',
              dom: expect.objectContaining({
                phase: ['replaceNotifications', 'mutateNotifications'].includes(
                  variant,
                )
                  ? 'initial_wait'
                  : 'messagebutton',
                navigation: expect.objectContaining({
                  splash: false,
                  logo: true,
                  fromMeta: true,
                  nav: true,
                  main: true,
                  dialog: true,
                  hidden: false,
                  dialogHeading: [
                    'unknownNotifications',
                    'replaceNotifications',
                    'mutateNotifications',
                  ].includes(variant)
                    ? ['other_redacted']
                    : expect.any(Array),
                }),
              }),
            }),
          );
          // The failure DOM intentionally preserves visible headings; startup
          // metadata only keeps the allowlisted heading classification.
          expect(
            JSON.stringify(
              f.persistFailureShot.mock.calls.map(
                ([, shot]) =>
                  (shot.dom as { navigation?: unknown } | undefined)
                    ?.navigation,
              ),
            ),
          ).not.toContain('Unknown fixture heading');
        } finally {
          await f.close();
        }
      },
    );
    it.each([{ lexical: true }, { textarea: true }])(
      'recovers only a prior undelivered draft (%j)',
      async (variant) => {
        const f = await fixture({
          ...variant,
          draftText: '  Earlier \n draft ',
          priorBodies: ['Earlier draft'],
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events.filter((event) => event === 'send')).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
    );
    it.each([{ priorBodies: [] }, { priorBodies: ['Another draft'] }])(
      'preserves an unknown or delivered draft (%j)',
      async ({ priorBodies }) => {
        const f = await fixture({
          lexical: true,
          draftText: 'Existing draft',
          priorBodies,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'unavailable',
            reasonUk: expect.stringContaining('чернетку'),
          });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.inputs).toEqual([]);
          expect(f.events).not.toContain('send');
        } finally {
          await f.close();
        }
      },
    );
    it('follows ig.me into a verified direct thread before sending', async () => {
      const f = await fixture({
        deepLinkSuccess: true,
        directConversation: true,
      });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.requests).toEqual([
          'ig.me/m/fixture_company',
          'www.instagram.com/direct/t/fixture-thread/',
        ]);
        expect(f.events).toEqual(['direct-open', 'mark', 'send']);
      } finally {
        await f.close();
      }
    });
    it('waits through the Instagram splash after ig.me redirects into the app', async () => {
      const f = await fixture({
        splashDeepLink: true,
        directConversation: true,
      });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.events).toEqual(['direct-open', 'mark', 'send']);
        expect(f.mark).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'waits for the app shell after delayed navigation without repeating goto (stalled document: %s)',
      async (stalledNavigation) => {
        const f = await fixture({
          delayedSplash: true,
          stalledNavigation,
          timeoutMs: 1000,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.events).toEqual(['open', 'mark', 'send']);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(
            f.requests.filter(
              (request) => request === 'www.instagram.com/fixture_company/',
            ),
          ).toHaveLength(2);
        } finally {
          await f.close();
        }
      },
    );
    it.each([false, true])(
      'preserves a Direct click failure through sending and failure capture (actionability blocked: %s)',
      async (blocked) => {
        const f = await fixture({
          recoverViaHome: true,
          directClickFailure: !blocked,
          directClickBlocked: blocked,
          timeoutMs: 120,
        });
        try {
          const error = await f.send().catch((error) => error);
          expect(error).toMatchObject({
            stage: 'direct_click',
            errorKind: blocked ? 'timeout' : 'unconfirmed',
            startupErrorKind: blocked ? 'TimeoutError' : 'detached_element',
          });
          expect(error.screen).toBeUndefined();
          expect(error.reasonUk).toContain('startupStage=direct_click');
          expect(error.reasonUk).not.toMatch(/private|account-id|https:/);
          expect(f.persistFailureShot).toHaveBeenCalledWith(
            'send',
            expect.objectContaining({
              stage: 'direct_click',
              jpeg: expect.stringMatching(/^\/9j\//),
              dom: expect.objectContaining({ phase: 'direct_click' }),
            }),
          );
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([undefined, 'fixture-thread', 'redirect'])(
      'boots via the unique home Direct link and rechecks the original recipient (%s)',
      async (knownThreadId) => {
        const f = await fixture({
          recoverViaHome: true,
          knownThreadId:
            knownThreadId === 'redirect' ? undefined : knownThreadId,
          directThreadRedirect: knownThreadId === 'redirect',
          homeDirectLinks:
            knownThreadId === 'redirect'
              ? `<a href="/direct/inbox/" onclick="event.preventDefault();location.assign('/direct/t/fixture-thread/')">Messages</a>`
              : undefined,
          directConversation: knownThreadId === 'fixture-thread',
          timeoutMs: 250,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          const home = f.requests.indexOf('www.instagram.com/');
          expect(home).toBeGreaterThan(0);
          expect(f.requests.slice(home, home + 3)).toEqual([
            'www.instagram.com/',
            knownThreadId === 'redirect'
              ? 'www.instagram.com/direct/t/fixture-thread/'
              : 'www.instagram.com/direct/inbox/',
            knownThreadId === 'fixture-thread'
              ? 'www.instagram.com/direct/t/fixture-thread/'
              : 'www.instagram.com/fixture_company/',
          ]);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events.filter((event) => event === 'send')).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      '<a href="/direct/inbox/">One</a><a href="/direct/inbox/">Two</a>',
      '<a href="https://foreign.invalid/direct/inbox/">Messages</a>',
      '<a href="https://www.instagram.com/direct/inbox/?token=private">Messages</a>',
      '<article><a href="/direct/inbox/">Messages</a></article>',
      '<div role="dialog"><nav><a href="/direct/inbox/">Messages</a></nav></div>',
      '<div role="log"><a href="/direct/inbox/">Messages</a></div>',
      '<div contenteditable="true"><a href="/direct/inbox/">Messages</a></div>',
    ])(
      'refuses an ambiguous or unverified home Direct link (%s)',
      async (homeDirectLinks) => {
        const f = await fixture({
          recoverViaHome: true,
          homeDirectLinks,
          timeoutMs: 120,
        });
        try {
          await expect(f.send()).rejects.toBeDefined();
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.inputs).toEqual([]);
          expect(f.requests).not.toContain('www.instagram.com/direct/inbox/');
          expect(
            f.requests.some((request) => request.includes('foreign.invalid')),
          ).toBe(false);
        } finally {
          await f.close();
        }
      },
    );
    it('does not send to an unverified recipient after home startup recovery', async () => {
      const f = await fixture({ recoverViaHome: true, wrongRecipient: true });
      try {
        await expect(f.send()).rejects.toBeDefined();
        expect(f.requests).toContain('www.instagram.com/direct/inbox/');
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('preserves a rate limit returned by the recovered Direct navigation', async () => {
      const f = await fixture({
        recoverViaHome: true,
        recoveredDirectStatus: 429,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ code: 'rate_limit' });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('preserves a checkpoint reached during home recovery', async () => {
      const f = await fixture({ recoverViaHome: true, homeCheckpoint: true });
      try {
        await expect(f.send()).rejects.toMatchObject({ reason: 'checkpoint' });
        expect(f.requests).not.toContain('www.instagram.com/direct/inbox/');
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it('does not treat an unscoped Direct anchor as app navigation', async () => {
      const f = await fixture({
        recoverViaHome: true,
        homeMarkup:
          '<main><nav><a href="/accounts/edit/">Account</a></nav><a href="/direct/inbox/">Decoy</a></main>',
      });
      try {
        await expect(f.send()).rejects.toBeDefined();
        expect(f.requests).not.toContain('www.instagram.com/direct/inbox/');
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it.each([401, 403, 429])(
      'stops before Direct on restricted home GraphQL HTTP %s',
      async (homeGraphqlStatus) => {
        const f = await fixture({ recoverViaHome: true, homeGraphqlStatus });
        try {
          await expect(f.send()).rejects.toMatchObject({
            reason: homeGraphqlStatus === 429 ? 'rate_limit' : 'unknown_auth',
          });
          expect(f.requests).not.toContain('www.instagram.com/direct/inbox/');
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it('refuses a Direct link resolved through a foreign base URL', async () => {
      const f = await fixture({
        recoverViaHome: true,
        homeMarkup:
          '<base href="https://foreign.invalid/"><main><nav><a href="/direct/inbox/">Messages</a></nav></main>',
      });
      try {
        await expect(f.send()).rejects.toMatchObject({
          reason: 'unknown_auth',
        });
        expect(
          f.requests.some((request) => request.includes('foreign.invalid')),
        ).toBe(false);
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it.each([
      '<main><nav><a href="/direct/inbox">Messages</a></nav></main>',
      '<div><a href="/">Home</a><a href="/reels/">Reels</a><a href="/direct/inbox/">Messages</a><a href="/explore/">Explore</a></div><main>Home feed</main>',
    ])(
      'accepts the verified Direct path and observed unlabelled app rail (%s)',
      async (homeMarkup) => {
        const f = await fixture({ recoverViaHome: true, homeMarkup });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.mark).toHaveBeenCalledOnce();
        } finally {
          await f.close();
        }
      },
    );
    it('preserves a challenge reached by the home Direct click', async () => {
      const f = await fixture({
        recoverViaHome: true,
        recoveredCheckpoint: true,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ reason: 'checkpoint' });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('stops on GraphQL rate limiting during resumed recipient navigation', async () => {
      const f = await fixture({
        recoverViaHome: true,
        resumedGraphqlStatus: 429,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ reason: 'rate_limit' });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it('stops at login during home startup recovery', async () => {
      const f = await fixture({ recoverViaHome: true, homeLogin: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          reason: 'login_required',
        });
        expect(f.requests).not.toContain('www.instagram.com/direct/inbox/');
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it('reports a persistent splash as a navigation timeout without dispatch', async () => {
      const f = await fixture({
        splash: true,
        splashShell: true,
        timeoutMs: 120,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({
          stage: 'navigation',
          errorKind: 'timeout',
          screen: 'splash',
          reasonUk: expect.stringContaining('[screen=splash]'),
        });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.events).not.toContain('send');
        expect(f.inputs).toEqual([]);
        expect(
          f.requests.filter(
            (request) => request === 'www.instagram.com/fixture_company/',
          ),
        ).toHaveLength(1);
        expect(f.requests.at(-1)).toBe('www.instagram.com/');
      } finally {
        await f.close();
      }
    });
    it('captures splash network failures without retaining URLs or arbitrary errors', async () => {
      const f = await fixture({
        splash: true,
        failedScript: true,
        timeoutMs: 120,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ screen: 'splash' });
        expect(f.persistFailureShot).toHaveBeenCalledWith(
          'send',
          expect.objectContaining({
            dom: expect.objectContaining({
              navigation: expect.objectContaining({
                mode: 'worker_context',
                viewport: { width: 1280, height: 720 },
                network: expect.arrayContaining([
                  {
                    resource: 'script',
                    mainDocument: false,
                    error: 'ERR_CONNECTION_REFUSED',
                  },
                ]),
              }),
            }),
          }),
        );
        expect(JSON.stringify(f.persistFailureShot.mock.calls)).not.toContain(
          '/failed-script',
        );
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it('stops when home also stays on splash without dispatching or repeating the failed navigation', async () => {
      const f = await fixture({
        splash: true,
        knownThreadId: 'fixture-thread',
        timeoutMs: 120,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({
          stage: 'navigation',
          errorKind: 'timeout',
          screen: 'splash',
        });
        expect(f.requests).toEqual([
          'www.instagram.com/direct/t/fixture-thread/',
          'www.instagram.com/',
        ]);
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.inputs).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it.each([undefined, 'fixture-thread'])(
      'captures a splash before DOMContentLoaded on profile/direct navigation (%s)',
      async (knownThreadId) => {
        const f = await fixture({
          splash: true,
          stalledNavigation: true,
          knownThreadId,
          timeoutMs: 120,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            stage: 'navigation',
            errorKind: 'timeout',
            screen: 'splash',
          });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.persistFailureShot).toHaveBeenCalledWith(
            'send',
            expect.objectContaining({
              stage: 'navigation',
              dom: expect.objectContaining({
                phase: 'navigation',
                urlPattern: '/',
                title: 'Instagram',
                elapsedMs: expect.any(Number),
                navigation: expect.objectContaining({
                  splashElement: true,
                  logo: true,
                  fromMeta: true,
                  nav: false,
                  main: false,
                  dialog: false,
                  hidden: false,
                  login: false,
                  challenge: false,
                  waitedSeconds: expect.any(Number),
                }),
              }),
            }),
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each(['check', 'keepalive'] as const)(
      'classifies a persistent %s splash before checking authentication',
      async (operation) => {
        const f = await fixture({ splash: true, timeoutMs: 120 });
        try {
          await expect(f[operation]()).rejects.toMatchObject({
            reason: 'timeout',
            errorKind: 'timeout',
            ...(operation === 'check'
              ? {
                  diagnostic: {
                    stage: 'navigation',
                    screen: 'splash',
                    errorKind: 'timeout',
                  },
                }
              : {}),
          });
          expect(f.requests).toEqual(['www.instagram.com/']);
        } finally {
          await f.close();
        }
      },
    );
    it('keeps a persistent ig.me splash classified and available as failure DOM', async () => {
      const f = await fixture({ splashAtDeepLink: true, timeoutMs: 120 });
      try {
        await expect(f.send()).rejects.toMatchObject({
          stage: 'navigation',
          errorKind: 'timeout',
          screen: 'splash',
        });
        expect(f.persistFailureShot).toHaveBeenCalledWith(
          'send',
          expect.objectContaining({
            dom: expect.objectContaining({
              title: 'Instagram',
              phase: 'navigation',
              urlPattern: '/<id>/<id>',
            }),
          }),
        );
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it('opens a known Instagram thread directly before trying ig.me', async () => {
      const f = await fixture({
        knownThreadId: 'fixture-thread',
        directConversation: true,
      });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.requests).toEqual([
          'www.instagram.com/direct/t/fixture-thread/',
        ]);
        expect(f.events).toEqual(['direct-open', 'mark', 'send']);
      } finally {
        await f.close();
      }
    });
    it('fills the observed unnamed Lexical textbox while excluding header/sidebar editors', async () => {
      const f = await fixture({ lexical: true, lexicalDecoys: true });
      try {
        await expect(f.send()).resolves.toBe(
          'https://www.instagram.com/direct/t/fixture-thread/',
        );
        expect(f.requests).toEqual([
          'ig.me/m/fixture_company',
          'www.instagram.com/fixture_company/',
        ]);
        expect(f.inputs).toEqual(['textbox']);
        expect(f.events).toEqual(['open', 'mark', 'send']);
        expect(f.mark).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });
    it.each([
      { inboxComposer: 'en' },
      { inboxComposer: 'uk' },
      { inboxComposer: 'en', delayedComposer: true },
      { inboxComposer: 'uk', containerHeader: true, narrowInboxHeader: true },
    ])(
      'selects only the lower chat editor in the shared inbox main (%j)',
      async (options) => {
        const f = await fixture({ ...options, timeoutMs: 600 });
        try {
          await expect(f.send()).resolves.toContain(
            '/direct/t/fixture-thread/',
          );
          expect(f.inputs).toEqual(['chat-composer']);
          expect(f.events).toEqual(['open', 'mark', 'send']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { ambiguousInboxComposer: true },
      { upperInboxComposer: true },
      { unsafeComposerLabel: true },
      { inboxMarkerAmbiguity: true },
    ])('fails closed with safe composer diagnostics (%j)', async (options) => {
      const f = await fixture({ inboxComposer: 'en', ...options });
      try {
        const error = (await f.send().catch((caught: unknown) => caught)) as {
          code: string;
          stage: string;
          reasonUk: string;
          taskResult: {
            composer: { counts: Record<string, number>; attrs: unknown[] };
          };
        };
        expect(error).toMatchObject({
          code: options.inboxMarkerAmbiguity
            ? 'delivery_uncertain'
            : 'unavailable',
          stage: 'composer',
        });
        expect(error.reasonUk).toContain('composer_counts=');
        expect(error.reasonUk).toContain('"named":0');
        expect(error.reasonUk).toContain('"panel":');
        expect(error.reasonUk).toContain('"role":"textbox"');
        expect(error.reasonUk).toContain('"contenteditable":"true"');
        expect(error.reasonUk).toContain('"rect":');
        expect(error.taskResult.composer.counts.named).toBe(0);
        expect(error.taskResult.composer.attrs.length).toBeGreaterThan(0);
        expect(JSON.stringify(error.taskResult)).not.toMatch(
          /fixture_company|Synthetic message|synthetic-private|@example/,
        );
        expect(error.reasonUk).not.toMatch(
          /fixture_company|Synthetic message|synthetic-private|@example/,
        );
        if (options.unsafeComposerLabel)
          expect(error.reasonUk).toContain('[redacted]');
        expect(f.inputs).toEqual(
          options.inboxMarkerAmbiguity ? ['chat-composer'] : [],
        );
        expect(f.events).not.toContain('send');
        expect(f.mark).toHaveBeenCalledTimes(
          options.inboxMarkerAmbiguity ? 1 : 0,
        );
      } finally {
        await f.close();
      }
    });
    it.each([
      ['Напишите сообщение…', 'ru'],
      ['Напишіть повідомлення…', 'uk'],
      ['mEsSaGe...', 'en'],
    ])(
      'fills the %s Lexical composer and confirms a link-only chat header (%s)',
      async (lexicalPlaceholder) => {
        const f = await fixture({
          lexical: true,
          lexicalPlaceholder,
          containerHeader: true,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.inputs).toEqual(['textbox']);
          expect(f.events).toEqual(['open', 'mark', 'send']);
          expect(f.mark).toHaveBeenCalledOnce();
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      {},
      { innerDialog: true },
      { nestedSemanticHeader: true },
      { outerSemanticHeader: true },
    ])(
      'confirms the observed div pagelet with a Lexical composer (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          lexicalDecoys: true,
          ...options,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.requests).toEqual([
            'ig.me/m/fixture_company',
            'www.instagram.com/fixture_company/',
          ]);
          expect(f.inputs).toEqual(['textbox']);
          expect(f.events).toEqual(['open', 'mark', 'send']);
          expect(f.mark).toHaveBeenCalledOnce();
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { wrongRecipient: true },
      { hiddenRecipient: true },
      { sidebarOnlyRecipient: true },
      { unknownPagelet: true },
      { foreignNestedDialog: true },
      { splitPane: true },
      { groupRecipient: true },
      { nestedSemanticHeader: true, groupRecipient: true },
      { staleHeader: true },
      { ambiguousDialog: true },
    ])(
      'blocks an unconfirmed pagelet recipient before input (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          ...options,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'unavailable',
            stage: 'dialog',
          });
          expect(f.inputs).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events).toEqual(['open']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { switchRecipient: true, code: 'delivery_uncertain', stage: 'dialog' },
      { hideRecipient: true, code: 'delivery_uncertain', stage: 'dialog' },
      { switchComposer: true, code: 'delivery_uncertain', stage: 'composer' },
      { switchContainer: true, code: 'delivery_uncertain', stage: 'dialog' },
      { markerFailure: true, code: 'delivery_uncertain', stage: 'attempt' },
      { markerRateLimit: true, code: 'rate_limit', stage: 'session' },
    ])(
      'preserves the pagelet durable marker gates (%j)',
      async ({ code, stage, ...options }) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          ...options,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({ code, stage });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).not.toContain('send');
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { lexicalPlaceholder: 'Search' },
      { lexicalPlaceholder: 'Message... search' },
      { noneditableComposer: true },
      { readonlyComposer: true },
      { nonTextboxComposer: true },
      { noComposer: true },
      { duplicateLexical: true },
    ])(
      'does not select or send with unsafe Lexical composer %j',
      async (options) => {
        const f = await fixture({
          lexical: true,
          lexicalDecoys: true,
          ...options,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'unavailable',
            stage: 'composer',
          });
          expect(f.inputs).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events).toEqual(['open']);
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
      { englishMenuLabel: true },
      { existingMenu: true },
      { existingMenu: true, harmlessMenu: true, sanitizedMenu: true },
      { existingMenu: true, sanitizedMenu: true },
      { existingMenu: true, controls: true, menuDialog: true },
      { existingMenu: true, menuDialog: true, bodyScrollLock: true },
      { existingMenu: true, menuDialog: true, menuAncestorAriaHidden: true },
      {
        existingMenu: true,
        sanitizedMenu: true,
        bodyScrollLock: true,
        menuAncestorAriaHidden: true,
      },
      { reuseHidden: true, controls: true },
      { existingMenu: true, delayedActionChange: 'enable', timeoutMs: 1000 },
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
        expect(f.requests).toEqual([
          'ig.me/m/fixture_company',
          'www.instagram.com/fixture_company/',
        ]);
      } finally {
        await f.close();
      }
    });
    it.each([
      ['wrongOptionsScope', 'messagebutton'],
      ['unknownOptions', 'messagebutton'],
      ['duplicateOptions', 'messagebutton'],
      ['dangerousOverlay', 'messagebutton'],
      ['alreadyExpanded', 'messagebutton'],
      ['noExpandedTransition', 'messagebutton'],
      ['wrongPopupRole', 'messagebutton'],
      ['reuseHidden', 'messagebutton'],
      ['menuRecipientMismatch', 'messagebutton'],
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
            'dangerousOverlay',
            'alreadyExpanded',
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
        expect(f.requests).toEqual([
          'www.instagram.com/fixture_company/',
          'ig.me/m/fixture_company',
          'www.instagram.com/fixture_company/',
        ]);
      } finally {
        await f.close();
      }
    });
    it.each([
      [
        'dangerousOverlay',
        '[branch=preexisting_popup; menus=0; dialogs=1; options=1]',
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
    it.each([
      ['reuseVisible', 'popup_changed'],
      ['mutateExisting', 'popup_changed'],
      ['duplicateMenu', 'popup_ambiguous'],
      ['wrongControls', 'popup_association'],
    ])(
      'rejects stale/foreign popup provenance %s without selecting a decoy',
      async (option, branch) => {
        const f = await fixture({
          overflow: true,
          existingMenu: true,
          controls: true,
          [option!]: true,
        });
        try {
          const error = await f.send().catch((error) => error);
          expect(error).toMatchObject({
            code: 'unavailable',
            stage: 'messagebutton',
            errorKind: 'unconfirmed',
            reasonUk: expect.stringContaining(`[branch=${branch};`),
          });
          expect(error.reasonUk).not.toMatch(
            /fixture_company|Synthetic message|https:|cookie/i,
          );
          expect(f.events).toEqual(['options']);
          expect(f.inputs).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      ['detachExisting', 'baseline_detached'],
      ['hideExisting', 'baseline_hidden'],
      ['mutateExisting', 'baseline_semantics'],
    ])(
      'identifies changed baseline menus (%s) without weakening provenance',
      async (option, cause) => {
        const f = await fixture({
          overflow: true,
          existingMenu: true,
          [option!]: true,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            stage: 'messagebutton',
            reasonUk: expect.stringContaining(`[change=${cause}]`),
          });
          expect(f.events).toEqual(['options']);
          expect(f.inputs).toEqual([]);
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it.each(['pointerenter', 'focus', 'pointerdown'])(
      'allows cosmetic React interaction changes on %s',
      async (interactionStyle) => {
        const f = await fixture({
          overflow: true,
          existingMenu: true,
          interactionStyle,
          timeoutMs: 1000,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.events).toEqual(['options', 'open', 'mark', 'send']);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.inputs).toEqual(['textbox']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      'block',
      'label',
      'move',
      'role',
      'popup',
      'replace',
      'disable',
      'hide',
    ])(
      'blocks %s changed by document capture before the target handler',
      async (documentCaptureChange) => {
        const f = await fixture({
          overflow: true,
          existingMenu: true,
          documentCaptureChange,
          timeoutMs: 1000,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            stage: 'messagebutton',
            reasonUk: expect.stringContaining('[branch=popup_changed;'),
          });
          expect(f.events).toEqual(['options', 'document-capture']);
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.inputs).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each(['block', 'label', 'move', 'role', 'popup', 'replace'])(
      'cancels the pinned action if %s changes while click waits for enabled',
      async (change) => {
        const f = await fixture({
          overflow: true,
          existingMenu: true,
          delayedActionChange: change,
          timeoutMs: 1000,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'unavailable',
            stage: 'messagebutton',
            errorKind: 'unconfirmed',
            reasonUk: expect.stringContaining('[branch=popup_changed;'),
          });
          expect(f.events).toEqual(['options']);
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
      ['domRateLimit', 'session', 'restricted', 'session_invalid'],
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
      ['duplicateComposer', 'composer', 'unconfirmed', 'unavailable'],
    ])(
      'stops safely for %s with a stage-specific reason',
      async (option, stage, errorKind, code) => {
        const f = await fixture({ [option!]: true });
        try {
          await expect(f.send()).rejects.toMatchObject({
            stage,
            errorKind,
            code,
            reasonUk: expect.stringContaining(
              option === 'groupRecipient'
                ? '[branch=header_recipient_mismatch; phase=initial; visible_anchors=2+; recognized_profiles=2+; mismatched_profiles=1]'
                : `[${stage}/${errorKind}]`,
            ),
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
      {},
      { existingMessage: true },
      { preserveComposer: true },
      { innerDialog: true },
      { textarea: true, lexical: false },
      { body: 'First line\nSecond line' },
      { clearComposer: true },
    ])(
      'accepts the observed container replacement after fill in the same conversation (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          mismatchPhase: 'after_fill',
          replaceContainer: true,
          ...options,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.events).toEqual([
            'open',
            'replace:container',
            'mark',
            'send',
          ]);
          expect(f.inputs).toEqual([
            'textarea' in options ? 'textarea' : 'textbox',
          ]);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.requests).toEqual([
            'ig.me/m/fixture_company',
            'www.instagram.com/fixture_company/',
          ]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { replacementCase: 'recipient' },
      { replacementCase: 'sidebar' },
      { replacementCase: 'dialogs' },
      { replacementCase: 'composers' },
      { replacementCase: 'foreign' },
      { replacementCase: 'unrelated' },
      { replacementCase: 'empty' },
      { replacementCase: 'readonly' },
      { dialogUrlParts: ['path'] },
    ])('blocks an unsafe replacement after fill (%j)', async (options) => {
      const f = await fixture({
        pageletHeader: true,
        lexical: true,
        mismatchPhase: 'after_fill',
        replaceContainer: true,
        ...options,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.events).toEqual(['open', 'replace:container']);
        expect(f.inputs).toEqual(['textbox']);
      } finally {
        await f.close();
      }
    });
    it.each(['switchRecipient', 'switchContainer', 'switchComposer'])(
      'does not rebind again when %s occurs after the replacement was marked',
      async (option) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          mismatchPhase: 'after_fill',
          replaceContainer: true,
          [option]: true,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'replace:container', 'mark']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      {},
      { existingMessage: true },
      { existingMessage: true, existingAuthor: 'fixture_company' },
      { malformedLink: true },
      { mismatchPhase: 'after_fill', replaceContainer: true },
      { body: 'First line\nSecond line', clearComposer: true },
    ])(
      'confirms a new article by its associated current-session sender (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          observedMessage: true,
          ...options,
        });
        try {
          await expect(f.send()).resolves.toBe(
            'https://www.instagram.com/direct/t/fixture-thread/',
          );
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual([
            'open',
            ...('replaceContainer' in options ? ['replace:container'] : []),
            'mark',
            'send',
          ]);
          expect(f.requests).toEqual([
            'ig.me/m/fixture_company',
            'www.instagram.com/fixture_company/',
          ]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { messageAuthor: 'fixture_company' },
      { messageAuthor: 'another_sender' },
      { noConfirmation: true },
      { existingMessage: true, noConfirmation: true },
      { existingMessage: true, noConfirmation: true, cloneOldMessage: true },
      { existingMessage: true, prependMessage: true },
      {
        existingMessage: true,
        existingBody: 'Old other body',
        noConfirmation: true,
        rewriteOldBody: true,
      },
      {
        existingMessage: true,
        messageAuthor: 'fixture_company',
        cloneOldMessage: true,
      },
      { senderMissing: true },
      { senderPictureMismatch: true },
      { senderOutsideRail: true },
      { ambiguousSender: true },
      { switchSenderAfterSend: true },
      { noMessageActions: true },
      { neighborActions: true },
      { multipleArticles: true },
      {
        markerMessage: true,
        mismatchPhase: 'after_marker',
        noConfirmation: true,
      },
    ])(
      'keeps delivery uncertain without new attributable outgoing evidence (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          observedMessage: true,
          ...options,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
            stage: 'confirmation',
            errorKind: 'timeout',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'mark', 'send']);
          expect(f.requests).toEqual([
            'ig.me/m/fixture_company',
            'www.instagram.com/fixture_company/',
          ]);
        } finally {
          await f.close();
        }
      },
    );
    it('does not confirm a cloned old outgoing message or retry after rerender', async () => {
      const f = await fixture({
        pageletHeader: true,
        lexical: true,
        mismatchPhase: 'after_fill',
        replaceContainer: true,
        existingMessage: true,
        noConfirmation: true,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'delivery_uncertain',
        });
        expect(f.mark).toHaveBeenCalledOnce();
        expect(f.events).toEqual(['open', 'replace:container', 'mark', 'send']);
      } finally {
        await f.close();
      }
    });
    it.each([
      ...['initial', 'after_fill', 'after_marker', 'after_send'].map(
        (mismatchPhase) => ({ mismatchPhase, headerMismatch: true }),
      ),
      ...['after_fill', 'after_marker', 'after_send'].flatMap(
        (mismatchPhase) => [
          ...(mismatchPhase === 'after_fill'
            ? []
            : [{ mismatchPhase, replaceContainer: true }]),
          { mismatchPhase, dialogUrlParts: ['path', 'query', 'hash'] },
          {
            mismatchPhase,
            replaceContainer: true,
            dialogUrlParts: ['path', 'query', 'hash'],
          },
        ],
      ),
      ...['path', 'query', 'hash'].map((part) => ({
        mismatchPhase: 'after_fill',
        dialogUrlParts: [part],
      })),
    ])(
      'retains bounded mismatch diagnostics in reasonUk (%j)',
      async (options) => {
        const f = await fixture({
          pageletHeader: true,
          lexical: true,
          ...options,
        });
        try {
          const error = await f.send().catch((error) => error);
          const postMarker = ['after_marker', 'after_send'].includes(
            options.mismatchPhase,
          );
          expect(error).toMatchObject({
            code: postMarker ? 'delivery_uncertain' : 'unavailable',
            stage: 'dialog',
            errorKind: 'mismatch',
          });
          const headerMismatch = 'headerMismatch' in options;
          const containerChanged = 'replaceContainer' in options;
          const parts =
            'dialogUrlParts' in options ? (options.dialogUrlParts ?? []) : [];
          const branch = headerMismatch
            ? 'header_recipient_mismatch'
            : containerChanged
              ? 'container_changed'
              : 'dialog_url_changed';
          const details = headerMismatch
            ? 'visible_anchors=2+; recognized_profiles=2+; mismatched_profiles=2+'
            : `container_changed=${containerChanged}; dialog_url_changed=${parts.length > 0}; origin_changed=false; path_changed=${parts.includes('path')}; query_changed=${parts.includes('query')}; hash_changed=${parts.includes('hash')}`;
          expect(error.reasonUk).toBe(
            `[dialog/mismatch] Діалог Instagram з потрібним одержувачем не підтверджено. [branch=${branch}; phase=${options.mismatchPhase}; ${details}]`,
          );
          expect(error.message).toBe(error.reasonUk);
          expect(error.reasonUk).not.toMatch(
            /https?:|fixture|private|Recipient|Synthetic message/,
          );
          expect(f.mark).toHaveBeenCalledTimes(postMarker ? 1 : 0);
          expect(f.events).toEqual([
            'open',
            ...(containerChanged && options.mismatchPhase !== 'after_send'
              ? ['replace:container']
              : []),
            ...(postMarker ? ['mark'] : []),
            ...(options.mismatchPhase === 'after_send' ? ['send'] : []),
            ...(containerChanged && options.mismatchPhase === 'after_send'
              ? ['replace:container']
              : []),
          ]);
          expect(f.inputs).toEqual(
            options.mismatchPhase === 'initial' ? [] : ['textbox'],
          );
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
            stage:
              option === 'markerFailure'
                ? 'attempt'
                : option === 'switchComposer'
                  ? 'composer'
                  : 'dialog',
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
