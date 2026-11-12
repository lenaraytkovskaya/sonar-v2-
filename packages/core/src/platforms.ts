import { load } from 'cheerio';
import {
  fopNames,
  linkedContact,
  sameSiteDomain,
  type SiteFact,
} from './scanner.js';

export type PlatformKind = 'classified' | 'minisite' | 'social' | 'maps';
export type PlatformKinds = Record<string, PlatformKind>;

/** The most specific configured domain wins; only complete hostname labels match. */
export function platformKind(
  host: string,
  kinds: PlatformKinds,
): PlatformKind | null {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  const match = Object.keys(kinds)
    .map((domain) => ({
      domain,
      normalized: domain.toLowerCase().replace(/\.$/, ''),
    }))
    .filter(
      ({ normalized: domain }) =>
        domain && (normalized === domain || normalized.endsWith(`.${domain}`)),
    )
    .sort((a, b) => b.normalized.length - a.normalized.length)[0];
  return match ? kinds[match.domain]! : null;
}

/** Public seller evidence only; URLs remain candidates until separately scanned. */
export function extractPlatformFacts(
  html: string,
  context: { url: string; kinds: PlatformKinds },
): SiteFact[] {
  const $ = load(html);
  const facts: SiteFact[] = [];
  const add = (kind: string, value: unknown) => {
    if (typeof value !== 'string') return;
    const clean = value.replace(/\s+/g, ' ').trim();
    if (
      clean &&
      !facts.some((fact) => fact.kind === kind && fact.value === clean)
    )
      facts.push({ kind, value: clean });
  };
  const addUrl = (value: unknown, profile = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = new URL(value, context.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return;
      url.hash = '';
      if (profile && sameSiteDomain(context.url, url.href))
        add('platform_profile', url.href);
      else if (
        !platformKind(url.hostname, context.kinds) &&
        !linkedContact(url.href, context.url)
      )
        add('website_candidate', url.href);
    } catch {
      /* Ignore malformed publisher URLs. */
    }
  };
  const seller = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(seller);
    const node = value as Record<string, unknown>;
    add('platform_seller', node.name);
    addUrl(node.url, true);
    for (const url of [node.sameAs].flat()) addUrl(url);
    if (node.address && typeof node.address === 'object')
      add(
        'platform_city',
        (node.address as Record<string, unknown>).addressLocality,
      );
  };
  const visit = (value: unknown, sellerEntity = true) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value))
      return value.forEach((child) => visit(child, sellerEntity));
    const node = value as Record<string, unknown>;
    seller(node.seller);
    addUrl(node.url);
    for (const url of [node.sameAs].flat()) addUrl(url);
    // Seller detail pages commonly expose the merchant as the main entity.
    if (
      sellerEntity &&
      String(node['@type']).match(
        /^(?:Person|Organization|LocalBusiness|Store)$/,
      )
    )
      seller(node);
    Object.entries(node).forEach(([key, child]) =>
      visit(
        child,
        sellerEntity && !['publisher', 'brand', 'manufacturer'].includes(key),
      ),
    );
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch {
      /* Ignore invalid JSON-LD. */
    }
  });
  const text = (selector: string) => {
    const element = $(selector).first();
    return element.attr('content') ?? element.text();
  };
  add(
    'platform_seller',
    text(
      '[data-testid="user-profile-user-name"], [data-cy="seller_name"], [data-qaid="company_name"], [itemprop="seller"] [itemprop="name"]',
    ),
  );
  add(
    'platform_city',
    text(
      '[data-testid="location-date"], [data-testid="map-link"], [data-qaid="company_location"], [itemprop="addressLocality"]',
    ).split(/,|\s+[–—-]\s+|\s+[•·]\s+/)[0],
  );
  $(
    'a[data-testid="user-profile-link"], a[data-cy="seller_profile"], a[data-qaid="company_link"], [itemprop="seller"] a[itemprop="url"]',
  ).each((_, element) => addUrl($(element).attr('href'), true));
  $('a[href]').each((_, element) => addUrl($(element).attr('href')));
  for (const fact of [...facts]) {
    if (fact.kind !== 'platform_seller') continue;
    const name = String(fact.value).replace(/^ФОП\s+/iu, '');
    for (const person of fopNames(`ФОП ${name}`))
      if (person === name) add('fop_name', person);
  }
  return facts;
}
