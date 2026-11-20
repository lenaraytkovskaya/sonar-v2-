import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureFailureDom, failureDomSkeleton } from './social-failure-dom.js';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'failure DOM privacy',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it('redacts correspondence, inputs, previews, arbitrary attributes and URL identities', async () => {
      const page = await browser.newPage();
      try {
        await page.route('https://www.facebook.com/fixture-profile/', (route) =>
          route.fulfill({ body: '<main></main>' }),
        );
        await page.goto('https://www.facebook.com/fixture-profile/');
        await page.setContent(`<main><h1>Fixture Name</h1><header><h2>Fixture Name</h2></header>
        <div role="log"><header><h2>Private heading</h2></header><div aria-label="Private label">Private body</div><button>Send</button></div>
        <div role="listitem"><h1>Private preview name</h1>Private preview</div>
        <div contenteditable="true" aria-placeholder="Private placeholder" data-testid="private-id">Private draft</div>
        <input value="Private input"><textarea>Private textarea</textarea>
        <a href="https://www.facebook.com/profile.php?id=123456&token=private-token" data-user-id="private-id" data-secret-value="hidden" data-person-123="hidden">Private link</a>
        <a href="/direct/t/secret-thread/">Private thread</a><header><button aria-label="Close">Close</button></header>
        <div aria-label="Messages in conversation with Fixture"><button>Inbox</button><h1>Private message heading</h1></div><div role="button" aria-label="Inbox">Inbox</div><div hidden>Private hidden</div><header aria-hidden="true"><h1>Private hidden heading</h1></header></main>`);
        const dom = await captureFailureDom(page);
        const json = JSON.stringify(dom);
        expect(json).not.toMatch(/Private|private|123456|secret-thread/);
        expect(json).not.toContain('Inbox');
        expect(json).toContain('Fixture Name');
        expect(json).not.toContain('Private heading');
        expect(json).toContain('/profile.php?id=<id>');
        expect(json).toContain('/direct/t/<id>/');
        expect(json).toContain('data-user-id');
        expect(json).not.toContain('data-secret-value');
        expect(json).not.toContain('data-person-123');
        expect(json).toContain('<text n=');
        expect(dom?.nodes.some((node) => node['aria-label'] === 'Close')).toBe(
          true,
        );
        expect(
          dom?.nodes.every(
            (node) => node.visible === true && Array.isArray(node.bbox),
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('prioritizes a floating chat outside main over a long profile', async () => {
      const page = await browser.newPage();
      try {
        await page.route('https://www.facebook.com/fixture-profile/', (route) =>
          route.fulfill({ body: '<main></main>' }),
        );
        await page.goto('https://www.facebook.com/fixture-profile/');
        await page.setContent(
          '<div id="app"><main><h1>Fixture Name</h1></main><section><div><div><div aria-label="Messages in conversation with Fixture"><div role="article">Private message</div></div><div contenteditable="true" aria-placeholder="Private draft" data-lexical-editor="true">Private input</div></div></div></section></div>',
        );
        await page.evaluate(() => {
          document
            .querySelector('main')!
            .insertAdjacentHTML(
              'beforeend',
              '<div style="position:fixed;top:0">Private profile</div>'.repeat(
                5000,
              ),
            );
        });
        const dom = await captureFailureDom(page);
        expect(dom?.truncated).toBe(true);
        expect(dom?.nodes.some((node) => node.contenteditable === 'true')).toBe(
          true,
        );
        expect(JSON.stringify(dom)).not.toContain('Private');
      } finally {
        await page.close();
      }
    });
    it('caps UTF-8 JSON size and keeps a valid tree when truncated', async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 1000 },
      });
      try {
        await page.route('https://www.instagram.com/direct/inbox/', (route) =>
          route.fulfill({ body: '<main></main>' }),
        );
        await page.goto('https://www.instagram.com/direct/inbox/');
        await page.setContent('<main style="position:fixed;inset:0"></main>');
        await page.evaluate(() => {
          document.querySelector('main')!.innerHTML = Array.from(
            { length: 5000 },
            () =>
              '<div role="button" style="position:fixed;top:0">秘密🔒</div>',
          ).join('');
        });
        const dom = await captureFailureDom(page);
        expect(
          Buffer.byteLength(JSON.stringify(dom), 'utf8'),
        ).toBeLessThanOrEqual(200 * 1024);
        expect(dom?.truncated).toBe(true);
        expect(
          dom?.nodes.every(
            (node, index) =>
              node.parent === null || Number(node.parent) < index,
          ),
        ).toBe(true);
        const small = await page.evaluate(failureDomSkeleton, 1024);
        expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(
          1024,
        );
      } finally {
        await page.close();
      }
    });
  },
);
