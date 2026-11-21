import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  changedThreads,
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
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<a href="/messages/t/1/">one</a><a href="/messages/e2ee/t/2/">two</a><a href="/messages/t/">root</a><div role="log" id="log"></div>
<script>
window.data = { '/messages/t/1': '1@msgr.1', '/messages/e2ee/t/2': '2@msgr.1' };
const render = () => { document.getElementById('log').innerHTML = '<div data-message-id="' + window.data[location.pathname.replace(/\\/$/, '')] + '">x</div>'; };
document.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); }));
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
      await page.evaluate(() => {
        (window as unknown as { data: Record<string, string> }).data[
          '/messages/e2ee/t/2'
        ] = '2@msgr.2';
      });
      expect(await sweepThreads(page, hrefs, seen, 5000)).toEqual([
        '/messages/e2ee/t/2/',
      ]);
      await context.close();
    });

    it('reacts to the title counter', async () => {
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
      expect(wakes).toBe(1);
      await page.close();
    });
  },
);
