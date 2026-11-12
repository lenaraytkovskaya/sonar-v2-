import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractPlatformFacts,
  platformKind,
  type PlatformKinds,
} from './platforms.js';
const kinds: PlatformKinds = {
  'olx.ua': 'classified',
  'olx.pl': 'classified',
  'prom.ua': 'classified',
  'google.com': 'maps',
  'sites.google.com': 'minisite',
  'facebook.com': 'social',
};
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/platforms/${name}.html`, import.meta.url),
    'utf8',
  );

describe('configured platform domains', () => {
  it.each([
    ['olx.ua', 'classified'],
    ['seller.prom.ua', 'classified'],
    ['WWW.OLX.PL.', 'classified'],
    ['google.com', 'maps'],
    ['sites.google.com', 'minisite'],
    ['nested.sites.google.com', 'minisite'],
    ['facebook.com', 'social'],
    ['olx.ua.attacker.test', null],
    ['fakeolx.ua', null],
    ['furniture.example.org', null],
    ['', null],
  ])('classifies %s as %s', (host, expected) => {
    expect(platformKind(host!, kinds)).toBe(expected);
  });
});

describe('platform facts from saved representative HTML fixtures', () => {
  it('extracts OLX seller/profile/city/own-site candidate and a full FOP name', () => {
    expect(
      extractPlatformFacts(fixture('olx'), {
        url: 'https://www.olx.ua/uk/d/obyavlenie/fixture',
        kinds,
      }),
    ).toEqual([
      { kind: 'platform_seller', value: 'Петренко Іван Петрович' },
      {
        kind: 'platform_profile',
        value: 'https://www.olx.ua/uk/list/user/fixture/',
      },
      { kind: 'website_candidate', value: 'https://furniture.example.org/' },
      { kind: 'platform_city', value: 'Київ' },
      { kind: 'fop_name', value: 'Петренко Іван Петрович' },
    ]);
  });
  it('extracts a Prom company subdomain without treating the store name as a person', () => {
    expect(
      extractPlatformFacts(fixture('prom'), {
        url: 'https://prom.ua/p123-fixture.html',
        kinds,
      }),
    ).toEqual([
      { kind: 'platform_seller', value: 'Майстерня Тепло' },
      { kind: 'platform_profile', value: 'https://teplo-fixture.prom.ua/' },
      { kind: 'website_candidate', value: 'https://teplo.example.org/' },
      { kind: 'platform_city', value: 'Львів' },
    ]);
  });
  it('collects ordinary external links and JSON-LD url/sameAs as candidates', () => {
    const html = `<a href="https://own.example.org/contact">Сайт</a>
      <a href="/company/42">Профіль</a>
      <a href="https://facebook.com/company">Facebook</a>
      <a href="https://linkedin.com/company/example">LinkedIn</a>
      <a href="https://wa.me/380673142758">WhatsApp</a>
      <script type="application/ld+json">{"@type":"WebPage","url":"https://own.example.org/","sameAs":["https://another.example.org/","https://prom.ua/profile"],"publisher":{"@type":"Organization","name":"Publisher","url":"https://publisher.example.org/"}}</script>`;
    expect(
      extractPlatformFacts(html, { url: 'https://prom.ua/p1', kinds }),
    ).toEqual([
      { kind: 'website_candidate', value: 'https://own.example.org/' },
      { kind: 'website_candidate', value: 'https://another.example.org/' },
      { kind: 'website_candidate', value: 'https://publisher.example.org/' },
      { kind: 'website_candidate', value: 'https://own.example.org/contact' },
    ]);
  });
  it('uses public HTML when JSON-LD is absent or invalid and rejects unsafe candidates', () => {
    const html = `<script type="application/ld+json">broken</script>
      <span data-qaid="company_name">Ковальчук О. І.</span>
      <span data-testid="location-date">Одеса, Приморський — Сьогодні о 12:00</span>
      <a data-qaid="company_link" href="/company/42">Профіль</a>
      <a data-qaid="company_site" href="javascript:alert(1)">Сайт</a>
      <a data-qaid="company_site" href="https://secret@external.test/">Сайт</a>
      <a data-qaid="company_site" href="https://facebook.com/store">Сторінка</a>`;
    expect(
      extractPlatformFacts(html, { url: 'https://prom.ua/p1', kinds }),
    ).toEqual([
      { kind: 'platform_seller', value: 'Ковальчук О. І.' },
      { kind: 'platform_city', value: 'Одеса' },
      { kind: 'platform_profile', value: 'https://prom.ua/company/42' },
      { kind: 'fop_name', value: 'Ковальчук О. І.' },
    ]);
  });
});
