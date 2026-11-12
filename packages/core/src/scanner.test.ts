import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeSiteHtml,
  extractSitePage,
  normalizeAiSiteResult,
  orderSiteUrls,
  robotsAllows,
  sameSiteDomain,
  shouldStopSiteScan,
  siteUrl,
} from './scanner.js';
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/scanner/${name}.html`, import.meta.url),
    'utf8',
  );
const context = { url: 'https://garage.ua/', country: 'UA' as const };
const page = (name: string) => extractSitePage(fixture(name), context);
const values = (name: string, kind: string) =>
  page(name)
    .contacts.filter((contact) => contact.kind === kind)
    .map((contact) => contact.value);

describe('website extraction from authored HTML fixtures', () => {
  it('extracts full FOP names and initials from visible website evidence', () => {
    expect(
      page('15-fop').facts.filter((fact) => fact.kind === 'fop_name'),
    ).toEqual([
      { kind: 'fop_name', value: 'Петренко Іван Петрович' },
      { kind: 'fop_name', value: 'Ковальчук О. І.' },
      { kind: 'fop_name', value: "Мар'яненко Анна-Лідія Юріївна" },
      { kind: 'fop_name', value: 'ГНАТЮК МАРІЯ ОЛЕГІВНА' },
    ]);
  });
  it('decodes mailto and obfuscated emails, ranks own domain, rejects examples/images', () => {
    expect(values('01-emails', 'email')).toEqual(
      expect.arrayContaining([
        'info@garage.ua',
        'office@garage.ua',
        'help@gmail.com',
        'sale@garage.ua',
        'contact@garage.ua',
      ]),
    );
    expect(values('01-emails', 'email')).toHaveLength(5);
    expect(
      page('01-emails').contacts.find((c) => c.value === 'info@garage.ua')!
        .rank,
    ).toBeGreaterThan(
      page('01-emails').contacts.find((c) => c.value === 'help@gmail.com')!
        .rank,
    );
  });
  it('normalizes Ukrainian phones and separates registration codes and dates', () => {
    expect(values('02-ukraine', 'phone')).toEqual([
      '+380442223344',
      '+380673142758',
    ]);
    expect(page('02-ukraine').facts).toEqual(
      expect.arrayContaining([
        { kind: 'edrpou', value: '12345678' },
        { kind: 'ipn', value: '3123456789' },
        { kind: 'language', value: 'uk' },
      ]),
    );
  });
  it.each([
    ['03-poland', 'PL', '+48225183764', '+48500100200'],
    ['04-germany', 'DE', '+49307215948', '+4915172038465'],
  ] as const)(
    'uses the company country for %s',
    (file, country, local, international) => {
      const result = extractSitePage(fixture(file), { ...context, country });
      expect(
        result.contacts.filter((c) => c.kind === 'phone').map((c) => c.value),
      ).toEqual(expect.arrayContaining([local, international]));
    },
  );
  it('extracts messenger profiles and invitations without share endpoints', () => {
    const contacts = page('05-messengers').contacts;
    expect(contacts.map((c) => c.kind)).toEqual([
      'telegram',
      'telegram',
      'whatsapp',
      'whatsapp',
      'whatsapp',
      'viber',
    ]);
    expect(contacts.some((c) => c.value.includes('/share/'))).toBe(false);
  });
  it('accepts social profiles and rejects shares, posts and lookalike hosts', () => {
    expect(values('06-social', 'social')).toHaveLength(5);
    expect(page('06-social').contacts.map((c) => c.meta?.network)).toEqual([
      'facebook',
      'instagram',
      'linkedin',
      'youtube',
      'tiktok',
    ]);
  });
  it('reads JSON-LD graph, preserves address fact and ranks structural phones', () => {
    const result = page('07-schema');
    expect(result.contacts.find((c) => c.kind === 'phone')).toMatchObject({
      value: '+380442223344',
      rank: 100,
    });
    expect(result.contacts.filter((c) => c.kind === 'phone')).toHaveLength(1);
    expect(result.contacts.find((c) => c.kind === 'email')?.value).toBe(
      'schema@garage.ua',
    );
    expect(
      JSON.stringify(result.facts.find((f) => f.kind === 'schema_org')),
    ).toContain('Main 1');
    expect(result.text).not.toContain('@graph');
  });
  it('recognizes contact forms, excluding search and records absence of captcha', () => {
    expect(values('08-form', 'form')).toEqual([context.url]);
    expect(page('08-form').facts).toContainEqual({
      kind: 'captcha',
      value: 'none',
    });
  });
  it.each([
    ['09-captchas', 'recaptcha_v2'],
    ['14-script-junk', 'turnstile'],
  ])(
    'detects form captcha in %s without treating the form as a challenge',
    (file, captcha) => {
      expect(page(file).facts).toContainEqual({
        kind: 'captcha',
        value: captcha,
      });
      expect(page(file).challenge).toBeNull();
    },
  );
  it.each([
    [
      '<form><input name="email"><textarea name="message"></textarea><script src="https://google.com/recaptcha/api.js?render=key"></script></form>',
      'recaptcha_v3',
    ],
    [
      '<form><input name="email"><textarea name="message"></textarea><div class="h-captcha"></div></form>',
      'hcaptcha',
    ],
  ])('recognizes remaining captcha types', (html, captcha) => {
    expect(extractSitePage(html, context).facts).toContainEqual({
      kind: 'captcha',
      value: captcha,
    });
  });
  it('detects empty SPA and blocking challenges; ignores hidden script contacts', () => {
    expect(page('10-spa').spa).toBe(true);
    expect(page('11-challenge').challenge).toBe('cloudflare');
    expect(page('14-script-junk').contacts.map((c) => c.kind)).toEqual([
      'form',
    ]);
  });
  it('distinguishes invisible reCAPTCHA v2, contact-free challenges and newsletter forms', () => {
    const invisible =
      '<form><textarea name="message"></textarea><div class="g-recaptcha" data-size="invisible"></div></form><script src="https://google.com/recaptcha/api.js?render=explicit"></script>';
    expect(extractSitePage(invisible, context).facts).toContainEqual({
      kind: 'captcha',
      value: 'recaptcha_v2',
    });
    expect(
      extractSitePage(
        '<h1>Complete captcha security check</h1><form><div class="h-captcha"></div></form>',
        context,
      ).challenge,
    ).toBe('captcha');
    expect(
      extractSitePage(
        '<form><input type="email"><button>Subscribe</button></form>',
        context,
      ).contacts,
    ).toEqual([]);
  });
  it('accepts Viber invitations, excluding forward and lookalike deep links', () => {
    const html =
      '<a href="https://invite.viber.com/?g2=invitation">Invite</a><a href="viber://forward?text=test">Share</a><a href="viber://chatter?number=x">Fake</a>';
    expect(extractSitePage(html, context).contacts.map((c) => c.value)).toEqual(
      ['https://invite.viber.com/?g2=invitation'],
    );
  });
  it('honors HTTP/meta charset including Windows-1251', () => {
    const html = fixture('13-charset');
    const bytes = Uint8Array.from(
      [...html].map((char) =>
        char === 'Є'
          ? 0xaa
          : char.charCodeAt(0) >= 0x410 && char.charCodeAt(0) <= 0x44f
            ? char.charCodeAt(0) - 0x350
            : char.charCodeAt(0),
      ),
    );
    expect(decodeSiteHtml(bytes)).toBe(html);
    expect(decodeSiteHtml(bytes, 'text/html; charset=windows-1251')).toBe(html);
    expect(
      extractSitePage(decodeSiteHtml(bytes), context).facts,
    ).toContainEqual({ kind: 'edrpou', value: '12345678' });
  });
});
describe('safe crawl planning and robots', () => {
  it('orders home, contact/about/privacy and sitemap contact pages before other home links', () => {
    const home = 'https://garage.co.uk/';
    const links = extractSitePage(fixture('12-navigation'), {
      ...context,
      url: home,
    }).links;
    expect(
      orderSiteUrls(home, links, [
        '/random',
        '/impressum',
        'https://evil.co.uk/contact',
      ]),
    ).toEqual([
      home,
      home + 'contact',
      home + '%D0%BF%D1%80%D0%BE-%D0%BD%D0%B0%D1%81',
      'https://shop.garage.co.uk/privacy',
      home + 'impressum',
      home + 'products',
    ]);
  });
  it('uses PSL including private suffixes; excludes files, protocols, credentials', () => {
    expect(sameSiteDomain('https://garage.co.uk', 'https://other.co.uk')).toBe(
      false,
    );
    expect(sameSiteDomain('https://a.github.io', 'https://b.github.io')).toBe(
      false,
    );
    expect(
      sameSiteDomain('https://garage.co.uk', 'https://shop.garage.co.uk'),
    ).toBe(true);
    for (const value of [
      '/x.JPG',
      '/x.pdf?download=1',
      'ftp://garage.ua/contact',
      'https://user:pass@garage.ua/contact',
      '/bad%zz',
    ])
      expect(siteUrl(value, context.url)).toBeNull();
  });
  it('handles malformed query escapes without decode failures', () => {
    expect(orderSiteUrls(context.url, ['/contact?query=%zz'])).toEqual([
      context.url,
      context.url + 'contact?query=%zz',
    ]);
  });
  it('stops only with all three channels or the configured page cap', () => {
    const contacts = [
      ...page('01-emails').contacts,
      ...page('02-ukraine').contacts,
    ];
    expect(shouldStopSiteScan(contacts, 2, 12)).toBe(false);
    expect(
      shouldStopSiteScan(
        [...contacts, ...page('05-messengers').contacts],
        3,
        12,
      ),
    ).toBe(true);
    expect(shouldStopSiteScan([], 12, 12)).toBe(true);
  });
  it('respects wildcard disallow, allow specificity and equal-length allow preference', () => {
    const robots =
      'User-agent: *\nDisallow: /private\nAllow: /private/contact\nDisallow: /*.pdf$\nDisallow: /same\nAllow: /same';
    expect(robotsAllows(robots, context.url + 'private', 'SonarBot/1.0')).toBe(
      false,
    );
    expect(
      robotsAllows(robots, context.url + 'private/contact', 'SonarBot/1.0'),
    ).toBe(true);
    expect(
      robotsAllows(robots, context.url + 'catalog.pdf', 'SonarBot/1.0'),
    ).toBe(false);
    expect(
      robotsAllows(robots, context.url + 'catalog.pdf?q=1', 'SonarBot/1.0'),
    ).toBe(true);
    expect(robotsAllows(robots, context.url + 'same', 'SonarBot/1.0')).toBe(
      true,
    );
  });
  it('selects and merges specific user-agent groups, tolerates empty directives/comments', () => {
    const robots =
      'User-agent: *\nDisallow: /blocked\nUser-agent: SonarBot\nDisallow: /admin # private\nUser-agent: SonarBot\nUser-agent: OtherBot\nDisallow: /secret\nAllow: /admin/contact\nDisallow:';
    expect(robotsAllows(robots, context.url, 'SonarBot/1.0')).toBe(true);
    expect(robotsAllows(robots, context.url + 'admin', 'SonarBot/1.0')).toBe(
      false,
    );
    expect(robotsAllows(robots, context.url + 'secret', 'SonarBot/1.0')).toBe(
      false,
    );
    expect(robotsAllows(robots, context.url + 'blocked', 'SonarBot/1.0')).toBe(
      false,
    );
    expect(robotsAllows(robots, context.url + 'blocked', 'UnknownBot')).toBe(
      false,
    );
  });
});
describe('AI fallback normalization with a stub result', () => {
  it('validates JSON, normalizes channels and annotates AI discoveries without modifying URL', () => {
    const result = normalizeAiSiteResult(
      JSON.stringify({
        emails: ['HELP@GARAGE.UA', 'HELP@GARAGE.UA', 'a@example.com'],
        phones: ['0673142758', '123'],
        messengers: ['https://t.me/garage', 'https://facebook.com/garage'],
        edrpou: '12345678',
      }),
      context,
    )!;
    expect(result.contacts.map((c) => c.kind)).toEqual([
      'email',
      'phone',
      'telegram',
    ]);
    expect(result.contacts.every((c) => c.meta?.ai === true)).toBe(true);
    expect(result.contacts.find((c) => c.kind === 'telegram')?.value).toBe(
      'https://t.me/garage',
    );
    expect(result.facts).toEqual([{ kind: 'edrpou', value: '12345678' }]);
  });
  it.each([
    'not json',
    '{}',
    { emails: [], phones: [], messengers: [], edrpou: null, prompt: 'bad' },
    { emails: [1], phones: [], messengers: [], edrpou: null },
  ])('ignores invalid AI output without throwing', (value) => {
    expect(normalizeAiSiteResult(value, context)).toBeNull();
  });
});
describe('placeholder phones', () => {
  it('drops template numbers and keeps real ones', async () => {
    const { placeholderPhone } = await import('./scanner.js');
    expect(placeholderPhone('+380671234567')).toBe(true);
    expect(placeholderPhone('+380500000000')).toBe(true);
    expect(placeholderPhone('+380449876543')).toBe(true);
    expect(placeholderPhone('+380636020707')).toBe(false);
    expect(placeholderPhone('+380443387518')).toBe(false);
  });
});
describe('feedback forms and clean links', () => {
  const forms = (html: string) =>
    extractSitePage(html, context)
      .contacts.filter((contact) => contact.kind === 'form')
      .map((contact) => contact.rank);
  it.each([
    '<form><input name="login"><input type="password" name="pass"><input name="email"></form>',
    '<form role="search"><input name="q"><input name="email"></form>',
    '<form action="/search"><input type="search" name="s"></form>',
    '<form class="add-to-cart"><input name="name"><input name="phone"><input name="qty"></form>',
    '<form><input name="email" placeholder="Email"><button>Підписатися</button></form>',
    '<form><input name="phone"><button>Передзвоніть мені</button></form>',
  ])('ignores non-feedback form %s', (html) => {
    expect(forms(html)).toEqual([]);
  });
  it('ranks forms with a message field above callback forms', () => {
    expect(
      forms('<form><input name="name"><input name="phone"></form>'),
    ).toEqual([30]);
    expect(
      forms(
        '<form><input name="name"><input type="hidden" name="token"><textarea name="description"></textarea></form>',
      ),
    ).toEqual([40]);
  });
  it('drops tracking parameters from social and Telegram links', () => {
    const links = extractSitePage(
      '<a href="https://www.tiktok.com/@fine.auto?_t=8nJE&_r=1">t</a><a href="https://instagram.com/garage/?igsh=abc">i</a><a href="https://www.facebook.com/profile.php?id=615&ref=x">f</a><a href="https://t.me/garage?start=1">tg</a>',
      context,
    ).contacts.map((contact) => contact.value);
    expect(links).toEqual([
      'https://www.tiktok.com/@fine.auto',
      'https://instagram.com/garage/',
      'https://www.facebook.com/profile.php?id=615',
      'https://t.me/garage',
    ]);
  });
});
