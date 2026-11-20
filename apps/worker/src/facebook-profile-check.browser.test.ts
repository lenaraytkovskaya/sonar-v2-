import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { inspectFacebookRecipient } from './facebook-send-browser.js';

const realSnapshot = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/fb-memories-new-message-popup-uk.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  dom: {
    nodes: Array<{
      tag: string;
      parent?: number | null;
      role?: string;
      'aria-label'?: string;
      href?: string;
      text?: string;
    }>;
  };
};

function snapshotHtml() {
  const parents = realSnapshot.dom.nodes.map((node) => node.parent ?? null);
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  parents.forEach((parent, index) => {
    if (parent === null) roots.push(index);
    else children.set(parent, [...(children.get(parent) ?? []), index]);
  });
  const render = (index: number): string => {
    const node = realSnapshot.dom.nodes[index]!;
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;');
    const attributes = [
      node.role ? ` role="${escape(node.role)}"` : '',
      node['aria-label'] ? ` aria-label="${escape(node['aria-label'])}"` : '',
      node.href ? ` href="${escape(node.href)}"` : '',
    ].join('');
    return `<${node.tag}${attributes}>${escape(node.text ?? '')}${(children.get(index) ?? []).map(render).join('')}</${node.tag}>`;
  };
  return `<html lang="uk"><body>${roots.map(render).join('')}</body></html>`;
}

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Facebook recipient profile check',
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    const url = 'https://www.facebook.com/profile.php?id=100000000000001';

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      await context.route('https://www.facebook.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><head><title>Facebook</title></head><body></body></html>',
        }),
      );
      page = await context.newPage();
      await page.goto(url);
    });
    afterAll(async () => {
      await context?.close();
      await browser?.close();
    });

    async function setProfile(language: string, button: string, extra = '') {
      await page.setContent(
        `<html lang="${language}"><body><main><h1>Test recipient</h1>${button}</main>${extra}</body></html>`,
      );
    }

    it.each([
      ['uk', 'Повідомлення'],
      ['en', 'Message'],
      ['ru', 'Сообщение'],
    ] as const)(
      'finds one visible message button for %s',
      async (language, label) => {
        await setProfile(language, `<button>${label}</button>`);
        const result = await inspectFacebookRecipient(
          page,
          '100000000000001',
          100,
        );
        expect(result).toMatchObject({
          profileUrlMatches: true,
          headingFound: true,
          messageButtonCount: 1,
          messageButtonCaption: label,
          messageButtonRole: 'button',
          language,
        });
      },
    );

    it('reports a missing button and several buttons without selecting either', async () => {
      await setProfile('uk', '');
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 25),
      ).toMatchObject({ messageButtonCount: 0, headingFound: true });
      await setProfile(
        'uk',
        '<button>Повідомлення</button><a href="#">Повідомлення</a>',
      );
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 25),
      ).toMatchObject({ messageButtonCount: 2 });
    });

    it('waits for a late heading and button, and reports a heading timeout', async () => {
      await page.setContent(
        '<html lang="uk"><body><main id="main"></main><script>setTimeout(() => { document.querySelector("main").innerHTML = "<h1>Test recipient</h1><button>Повідомлення</button>" }, 35)</script></body></html>',
      );
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 200),
      ).toMatchObject({ headingFound: true, messageButtonCount: 1 });
      await page.setContent(
        '<html lang="uk"><body><main></main></body></html>',
      );
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 25),
      ).toMatchObject({ headingFound: false, messageButtonCount: 0 });
    });

    it('confirms a profile with one message button even when the page has no h1', async () => {
      await page.setContent(
        '<html lang="uk"><body><main><div role="button" aria-label="Повідомлення">Повідомлення</div></main></body></html>',
      );
      const result = await inspectFacebookRecipient(
        page,
        '100000000000001',
        500,
      );
      expect(result).toMatchObject({
        headingFound: false,
        messageButtonCount: 1,
        profileUrlMatches: true,
      });
      expect(result.summaryUk).toContain('кнопку «Повідомлення» знайдено');
    });

    it('detects a Ukrainian new-message window and a login checkpoint', async () => {
      await setProfile(
        'uk',
        '<button>Повідомлення</button>',
        '<div role="dialog"><h2>Нове повідомлення</h2><label>Кому:</label><div role="log"></div><div contenteditable="true" role="textbox"></div></div>',
      );
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 50),
      ).toMatchObject({
        extraWindowCount: 1,
        hasNewMessageWindow: true,
        hasMiniChat: true,
      });
      await setProfile(
        'uk',
        '<button>Повідомлення</button>',
        '<form action="/checkpoint"><p>Підтвердьте свою особу</p></form>',
      );
      expect(
        await inspectFacebookRecipient(page, '100000000000001', 50),
      ).toMatchObject({ checkpointVisible: true, identityCheckVisible: true });
    });

    it('reconstructs the checked-in real Ukrainian Facebook snapshot by parent indices', async () => {
      expect(realSnapshot.dom.nodes.length).toBeGreaterThan(200);
      expect(snapshotHtml()).toContain('lang="uk"');
      await page.setContent(snapshotHtml());
      const result = await inspectFacebookRecipient(
        page,
        '100000000000001',
        25,
      );
      expect(result.headingFound).toBe(false);
      expect(result.messageButtonCount).toBe(0);
    });
  },
);
