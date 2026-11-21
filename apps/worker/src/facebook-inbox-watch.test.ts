import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
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
