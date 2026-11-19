import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readInstagramInboxDom } from './instagram-inbox-parser.js';

const fixture = readFileSync(
  new URL('./instagram-inbox-en.fixture.html', import.meta.url),
  'utf8',
);

it.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'recognizes screenshot-derived English inbox/thread labels with optional folders',
  async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: fixture }),
      );
      await page.goto('https://www.instagram.com/direct/inbox/');
      expect(await readInstagramInboxDom(page)).toEqual({
        messages: true,
        requests: true,
        primary: false,
        general: false,
        outgoing: 1,
        timestamps: 3,
        threadUrls: ['https://www.instagram.com/direct/t/900000000000005/'],
      });
      await page.locator('aside').evaluate((element) => {
        element.insertAdjacentHTML(
          'afterbegin',
          '<button role="tab">Primary</button><button role="tab">General</button>',
        );
        element.insertAdjacentHTML(
          'beforeend',
          '<a href="https://foreign.invalid/direct/t/123/">Foreign</a><a href="/direct/t/123/?token=private">Token</a><a hidden href="/direct/t/456/">Hidden</a>',
        );
      });
      expect(await readInstagramInboxDom(page)).toMatchObject({
        primary: true,
        general: true,
        threadUrls: ['https://www.instagram.com/direct/t/900000000000005/'],
      });
      for (const [messages, requests, primary, general, outgoing] of [
        ['Повідомлення', 'Запити', 'Основні', 'Загальні', 'Ви надіслали'],
        ['Сообщения', 'Запросы', 'Основные', 'Общие', 'Вы отправили'],
      ]) {
        await page.setContent(
          `<h2>${messages}</h2><button>${requests}</button><button role="tab">${primary}</button><button role="tab">${general}</button><div aria-label="${outgoing}">Synthetic text</div><span>Вчора</span>`,
        );
        expect(await readInstagramInboxDom(page)).toMatchObject({
          messages: true,
          requests: true,
          primary: true,
          general: true,
          outgoing: 1,
          timestamps: 1,
        });
      }
    } finally {
      await browser.close();
    }
  },
);
