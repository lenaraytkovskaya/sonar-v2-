import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  changedThreads,
  closeFacebookNotifications,
  MessengerSignalCooldown,
  focusThread,
  sweepThreads,
  messengerChanged,
  readMessengerSnapshot,
  watchMessenger,
  type MessengerSnapshot,
} from './facebook-inbox-watch.js';

const snap = (over: Partial<MessengerSnapshot> = {}): MessengerSnapshot => ({
  unread: 0,
  signature: 'a#x|y',
  blocked: false,
  ...over,
});

describe('messengerChanged', () => {
  it('ignores identical snapshots', () => {
    expect(messengerChanged(snap(), snap())).toBe(false);
  });
  it('fires on a higher unread counter', () => {
    expect(messengerChanged(snap(), snap({ unread: 1 }))).toBe(true);
  });
  it('does not fire when the counter drops after reading', () => {
    expect(messengerChanged(snap({ unread: 2 }), snap({ unread: 1 }))).toBe(
      false,
    );
  });
  it('fires on a new preview or thread order', () => {
    expect(messengerChanged(snap(), snap({ signature: 'a#x|z' }))).toBe(true);
  });
  it('fires when unread moves to another chat without changing the total or preview', () => {
    const threads = (second: boolean) => [
      { href: '/messages/t/1/', text: 'same', unread: !second },
      { href: '/messages/t/2/', text: 'same', unread: second },
    ];
    const previous = snap({ unread: 1, threads: threads(false) });
    const next = snap({ unread: 1, threads: threads(true) });
    expect(messengerChanged(previous, next)).toBe(true);
    expect(changedThreads(previous, next)).toEqual(['/messages/t/2/']);
    expect(
      messengerChanged(next, {
        ...next,
        unread: 0,
        threads: next.threads!.map((thread) => ({ ...thread, unread: false })),
      }),
    ).toBe(false);
  });
  it('does not fire while the list is empty', () => {
    expect(messengerChanged(snap(), snap({ signature: '' }))).toBe(false);
  });
});

describe('changedThreads', () => {
  const threads = (...rows: [string, string][]) =>
    rows.map(([href, text]) => ({ href, text }));
  it('names chats whose preview moved or that are new', () => {
    const before = snap({ threads: threads(['/messages/t/1/', 'a|x']) });
    const after = snap({
      threads: threads(['/messages/t/2/', 'b|y'], ['/messages/t/1/', 'a|z']),
    });
    expect(changedThreads(before, after)).toEqual([
      '/messages/t/2/',
      '/messages/t/1/',
    ]);
  });
  it('falls back to the top of the list on a bare counter rise', () => {
    const rows = threads(['/messages/t/1/', 'a'], ['/messages/t/2/', 'b']);
    expect(
      changedThreads(
        snap({ threads: rows }),
        snap({ threads: rows, unread: 1 }),
      ),
    ).toEqual(['/messages/t/1/', '/messages/t/2/']);
  });
  it('names the open chat when its newest message changes', () => {
    const open = (last: string, href = '/messages/e2ee/t/5') => ({
      href,
      last,
    });
    expect(
      changedThreads(snap({ open: open('a@1') }), snap({ open: open('a@2') })),
    ).toEqual(['/messages/e2ee/t/5']);
    expect(
      changedThreads(
        snap({ open: open('a@1') }),
        snap({ open: open('b@9', '/messages/e2ee/t/6') }),
      ),
    ).toEqual([]);
    expect(
      messengerChanged(
        snap({ open: open('a@1') }),
        snap({ open: open('a@2') }),
      ),
    ).toBe(true);
  });
  it('names nothing when nothing changed', () => {
    const rows = threads(['/messages/t/1/', 'a']);
    expect(
      changedThreads(snap({ threads: rows }), snap({ threads: rows })),
    ).toEqual([]);
  });
});

describe('MessengerSignalCooldown', () => {
  it('limits identical signals but accepts fresh previews and open messages', () => {
    const gate = new MessengerSignalCooldown();
    const before = snap();
    const badge = snap({
      unread: 1,
      threads: [{ href: '/messages/t/1/', text: 'same' }],
    });
    expect(gate.accept(before, badge, 0, 120000)).toBe(true);
    expect(gate.accept(before, badge, 20000, 120000)).toBe(false);
    expect(
      gate.accept(
        before,
        { ...badge, open: { href: '/messages/t/2/', last: 'old' } },
        30000,
        120000,
      ),
    ).toBe(false);
    expect(
      gate.accept(
        before,
        { ...badge, threads: [{ href: '/messages/t/1/', text: 'fresh' }] },
        30001,
        120000,
      ),
    ).toBe(true);
    expect(
      gate.accept(
        snap({ open: { href: '/messages/t/1/', last: '1' } }),
        { ...badge, open: { href: '/messages/t/1/', last: '2' } },
        30002,
        120000,
      ),
    ).toBe(true);
    expect(gate.accept(before, badge, 120000, 120000)).toBe(true);
  });
});

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'watchMessenger on a synthetic page',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    const html = (preview: string, title = 'Messenger') =>
      `<title>${title}</title><a href="/messages/t/1/"><span dir="auto">Name</span><span dir="auto">${preview}</span></a>`;

    it('wakes once per burst and respects the minimum gap', async () => {
      const page = await browser.newPage();
      await page.setContent(html('hello'));
      let wakes = 0;
      let stop = false;
      const run = watchMessenger(page, {
        onChange: async () => {
          wakes++;
        },
        stopped: () => stop,
        minGapMs: 400,
        scanMs: 50,
      });
      await page.evaluate(() => {
        document.querySelectorAll('span')[1]!.textContent = 'new 1';
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        document.querySelectorAll('span')[1]!.textContent = 'new 2';
      });
      await page.waitForTimeout(700);
      stop = true;
      expect(await run).toBe('stopped');
      expect(wakes).toBe(2);
      expect((await readMessengerSnapshot(page)).signature).toContain('new 2');
      await page.close();
    });

    it('ignores notification/title counters on the real Ukrainian snapshot with a foreign composer', async () => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/fb-memories-new-message-popup-uk.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const page = await browser.newPage();
      await page.setContent('<title>(1) Facebook</title>');
      await page.evaluate(
        (
          nodes: Array<{
            tag: string;
            parent?: number | null;
            role?: string;
            'aria-label'?: string;
            text?: string;
            href?: string;
          }>,
        ) => {
          const elements: HTMLElement[] = [];
          for (const node of nodes) {
            const element = document.createElement(node.tag);
            for (const key of ['role', 'aria-label', 'href'] as const)
              if (node[key]) element.setAttribute(key, node[key]!);
            element.textContent = node.text ?? '';
            (node.parent == null
              ? document.body
              : elements[node.parent]!
            ).append(element);
            elements.push(element);
          }
        },
        fixture.dom.nodes,
      );
      const snapshot = await readMessengerSnapshot(page);
      expect(snapshot.unread).toBe(0);
      expect(snapshot.blocked).toBe(false);
      expect(await closeFacebookNotifications(page)).toBe(false);
      expect(
        await page
          .getByRole('button', { name: 'Сповіщення', exact: true })
          .count(),
      ).toBe(1);
      await page.close();
    });

    it.each(['uk', 'en', 'ru'])(
      'reads Messenger badges and unread rows independently of notifications (%s)',
      async (language) => {
        const page = await browser.newPage();
        const labels: Record<string, string> = {
          uk: 'Непрочитане повідомлення',
          en: 'Unread message',
          ru: 'Непрочитанное сообщение',
        };
        await page.setContent(
          `${html('hello', '(9) Facebook')}<button aria-label="Messenger"><span>2</span></button><button aria-label="Notifications"><span>9</span></button><div role="dialog"><a href="/messages/t/999/" aria-label="Unread">Notification target</a></div><a style="display:none" href="/messages/t/8/"><span aria-label="${labels[language]}"></span></a>`,
        );
        expect((await readMessengerSnapshot(page)).unread).toBe(2);
        await page
          .locator('[aria-label="Messenger"] span')
          .evaluate((node) => node.remove());
        await page
          .locator('a')
          .first()
          .evaluate(
            (node, label) => node.setAttribute('aria-label', label),
            labels[language]!,
          );
        expect((await readMessengerSnapshot(page)).unread).toBe(1);
        await page
          .locator('a')
          .first()
          .evaluate((node) => node.setAttribute('aria-label', ''));
        await page
          .locator('a')
          .first()
          .locator('span')
          .nth(1)
          .evaluate((node) => {
            (node as HTMLElement).style.fontWeight = '700';
          });
        expect((await readMessengerSnapshot(page)).unread).toBe(1);
        await page.close();
      },
    );

    it.each(['Сповіщення', 'Notifications', 'Уведомления'])(
      'closes only an expanded %s toggle',
      async (label) => {
        const page = await browser.newPage();
        await page.setContent(
          `<nav><button aria-label="${label}" aria-expanded="true" onclick="this.setAttribute('aria-expanded','false')">toggle</button></nav><div role="dialog" aria-label="New message"><input value="untouched"></div>`,
        );
        expect(await closeFacebookNotifications(page)).toBe(true);
        expect(await closeFacebookNotifications(page)).toBe(false);
        expect(await page.locator('input').inputValue()).toBe('untouched');
        await page
          .locator('button')
          .evaluate((node) => node.removeAttribute('aria-expanded'));
        expect(await closeFacebookNotifications(page)).toBe(false);
        await page.locator('button').evaluate((node) => {
          node.setAttribute('aria-expanded', 'true');
          node.after(node.cloneNode(true));
        });
        expect(await closeFacebookNotifications(page)).toBe(false);
        await page.close();
      },
    );

    it('leaves foreign Notifications buttons inside chat content untouched', async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<nav><button aria-label="Notifications" aria-expanded="false">nav</button></nav><div role="log"><button aria-label="Notifications" aria-expanded="true" onclick="this.textContent='clicked'">foreign</button></div>`,
      );
      expect(await closeFacebookNotifications(page)).toBe(false);
      expect(await page.locator('[role="log"] button').textContent()).toBe(
        'foreign',
      );
      await page.close();
    });

    it('suppresses repeated badge oscillations and imports fresh incoming during cooldown', async () => {
      const page = await browser.newPage();
      await page.setContent(
        `${html('hello')}<button aria-label="Messenger"><span>0</span></button>`,
      );
      const wakes: string[][] = [];
      let stop = false;
      let scans = 0;
      const run = watchMessenger(page, {
        onChange: async (changed) => {
          wakes.push(changed);
        },
        stopped: () => stop,
        scanMs: 20,
        minGapMs: 30,
        signalCooldownMs: 120000,
        onScan: () => {
          scans++;
        },
      });
      const scan = async () => {
        const before = scans;
        await expect.poll(() => scans).toBeGreaterThan(before);
      };
      await scan();
      for (const value of ['1', '0', '1']) {
        await page.locator('button span').evaluate((node, text) => {
          node.textContent = text;
        }, value);
        await scan();
      }
      expect(wakes).toHaveLength(1);
      await page
        .locator('a span')
        .nth(1)
        .evaluate((node) => {
          node.textContent = 'fresh incoming';
        });
      await expect.poll(() => wakes.length).toBe(2);
      stop = true;
      await run;
      expect(wakes[1]).toEqual(['/messages/t/1/']);
      await page.close();
    });

    it('starts the same-signal cooldown at the delayed import wake', async () => {
      const page = await browser.newPage();
      await page.setContent(
        `${html('hello')}<button aria-label="Messenger"><span>0</span></button>`,
      );
      const wakes: number[] = [];
      let stop = false;
      let scans = 0;
      const run = watchMessenger(page, {
        onChange: async () => {
          wakes.push(Date.now());
        },
        stopped: () => stop,
        onScan: () => {
          scans++;
        },
        scanMs: 10,
        minGapMs: 200,
        signalCooldownMs: 400,
      });
      const count = async (value: string) => {
        const before = scans;
        await page.locator('button span').evaluate((node, text) => {
          node.textContent = text;
        }, value);
        await expect
          .poll(() => scans, { interval: 10 })
          .toBeGreaterThan(before);
      };
      await count('1');
      await expect.poll(() => wakes.length, { interval: 10 }).toBe(1);
      const detectedAt = Date.now();
      await count('2');
      await expect.poll(() => wakes.length, { interval: 10 }).toBe(2);
      // The signal was detected before the global gap allowed its import.
      await page.waitForTimeout(Math.max(0, detectedAt + 440 - Date.now()));
      await count('0');
      await count('2');
      expect(wakes).toHaveLength(2);
      stop = true;
      await run;
      await page.close();
    });

    it('stops on a PIN dialog without waking', async () => {
      const page = await browser.newPage();
      await page.setContent(html('hello'));
      let wakes = 0;
      const run = watchMessenger(page, {
        onChange: async () => {
          wakes++;
        },
        stopped: () => false,
        minGapMs: 0,
        scanMs: 50,
      });
      await page.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input autocomplete="one-time-code" maxlength="6">',
        );
      });
      expect(await run).toBe('blocked');
      expect(wakes).toBe(0);
      await page.close();
    });

    it('wakes when a message lands in the chat that stays open', async () => {
      const page = await browser.newPage();
      await page.setContent(
        `${html('hello')}<div role="log"><div data-message-id="1@msgr.1">a</div></div>`,
      );
      const woken: string[][] = [];
      let stop = false;
      const run = watchMessenger(page, {
        onChange: async (changed) => {
          woken.push(changed);
        },
        stopped: () => stop,
        minGapMs: 0,
        scanMs: 50,
      });
      await page.evaluate(() => {
        document
          .querySelector('[role="log"]')!
          .insertAdjacentHTML(
            'beforeend',
            '<div data-message-id="1@msgr.2">b</div>',
          );
      });
      await page.waitForTimeout(300);
      stop = true;
      await run;
      expect(woken).toHaveLength(1);
      expect(woken[0]).toHaveLength(1);
      await page.close();
    });

    it('sweeps the top chats and names the ones whose newest message moved', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      // What the "server" holds; an encrypted chat shows it only after a fresh load.
      const server: Record<string, string> = {
        '/messages/t/1': '1@msgr.1',
        '/messages/e2ee/t/2': '2@msgr.1',
      };
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<a href="/messages/t/1/">one</a><a href="/messages/e2ee/t/2/">two</a><a href="/messages/t/">root</a><div role="log" id="log"></div>
<script>
const data = ${JSON.stringify(server)};
const render = () => { document.getElementById('log').innerHTML = '<div data-message-id="' + data[location.pathname.replace(/\\/$/, '')] + '">x</div>'; };
document.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); }));
render();
</script>`,
        }),
      );
      const page = await context.newPage();
      await page.goto('https://www.facebook.com/messages/');
      const seen = new Map<string, string>();
      const hrefs = ['/messages/t/1/', '/messages/e2ee/t/2/', '/messages/t/'];
      expect(await sweepThreads(page, hrefs, seen, 5000)).toEqual([]);
      expect([...seen.keys()]).toEqual(['/messages/t/1', '/messages/e2ee/t/2']);
      expect(await sweepThreads(page, hrefs, seen, 5000)).toEqual([]);
      server['/messages/e2ee/t/2'] = '2@msgr.2';
      expect(await sweepThreads(page, hrefs, seen, 5000)).toEqual([
        '/messages/e2ee/t/2/',
      ]);
      await context.close();
    });

    it('adds the id of the own message carrying the seen avatar to the open chat key', async () => {
      const page = await browser.newPage();
      await page.setContent(
        `${html('hello')}<div role="log" style="width:400px"><div data-message-id="1@msgr.1">a</div><div data-message-id="1@msgr.2">b<img alt="seen" width="14" height="14" style="margin-left:360px"></div></div>`,
      );
      const snapshot = await readMessengerSnapshot(page);
      expect(snapshot.open?.last).toBe('1@msgr.2|1@msgr.2');
      await page.evaluate(() => {
        document.querySelector('img')!.remove();
      });
      expect((await readMessengerSnapshot(page)).open?.last).toBe('1@msgr.2|');
      await page.close();
    });

    it('ignores changes made while the page is driven by someone else', async () => {
      const page = await browser.newPage();
      await page.setContent(html('hello'));
      let wakes = 0;
      let paused = true;
      let stop = false;
      const run = watchMessenger(page, {
        onChange: async () => {
          wakes++;
        },
        stopped: () => stop,
        paused: () => paused,
        minGapMs: 0,
        scanMs: 30,
      });
      await page.evaluate(() => {
        document.querySelectorAll('span')[1]!.textContent = 'driven';
      });
      await page.waitForTimeout(200);
      paused = false;
      await page.waitForTimeout(200);
      stop = true;
      await run;
      expect(wakes).toBe(0);
      await page.close();
    });

    it('rests on the chosen chat by a click and ignores a missing one', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<a href="/messages/t/1/">one</a><a href="/messages/e2ee/t/2/">two</a>
<script>document.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); }));</script>`,
        }),
      );
      const page = await context.newPage();
      await page.goto('https://www.facebook.com/messages/');
      await focusThread(page, '/messages/e2ee/t/2/', 3000);
      expect(new URL(page.url()).pathname).toBe('/messages/e2ee/t/2/');
      await focusThread(page, '/messages/t/999/', 500);
      expect(new URL(page.url()).pathname).toBe('/messages/e2ee/t/2/');
      await context.close();
    });

    it('asks for a reload when the page shows no chats for a while', async () => {
      const page = await browser.newPage();
      await page.setContent('<title>Error</title><p>no network</p>');
      const events: string[] = [];
      const end = await watchMessenger(page, {
        onChange: async () => {},
        onEvent: (line) => events.push(line),
        stopped: () => false,
        minGapMs: 0,
        scanMs: 10,
        emptyReloadScans: 5,
      });
      expect(end).toBe('reload');
      expect(events).toContain('empty page, reloading');
      await page.close();
    });

    it('survives a navigation of the watched page', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<title>Messenger</title><a href="/messages/t/1/"><span dir="auto">a</span></a>',
        }),
      );
      const page = await context.newPage();
      await page.goto('https://www.facebook.com/messages/');
      let stop = false;
      const run = watchMessenger(page, {
        onChange: async () => {},
        stopped: () => stop,
        minGapMs: 0,
        scanMs: 10,
      });
      for (let i = 0; i < 5; i++) {
        await page.reload();
        await page.waitForTimeout(20);
      }
      stop = true;
      expect(await run).toBe('stopped');
      await context.close();
    });

    it('ignores notification counters in the title', async () => {
      const page = await browser.newPage();
      await page.setContent(html('hello'));
      let wakes = 0;
      let stop = false;
      const run = watchMessenger(page, {
        onChange: async () => {
          wakes++;
        },
        stopped: () => stop,
        minGapMs: 0,
        scanMs: 50,
      });
      await page.evaluate(() => {
        document.title = '(1) Messenger';
      });
      await page.waitForTimeout(300);
      stop = true;
      await run;
      expect(wakes).toBe(0);
      await page.close();
    });
  },
);
