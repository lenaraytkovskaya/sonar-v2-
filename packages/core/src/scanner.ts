import { load } from 'cheerio';
import {
  findPhoneNumbersInText,
  type CountryCode,
} from 'libphonenumber-js/max';
import { getDomain } from 'tldts';
import { z } from 'zod';
import { normalizePhone } from './index.js';
import { normalizeRegistryName } from './registry.js';

export interface SiteContact {
  kind:
    'email' | 'phone' | 'telegram' | 'whatsapp' | 'viber' | 'social' | 'form';
  value: string;
  rank: number;
  meta?: Record<string, unknown>;
}
export interface SiteFact {
  kind: string;
  value: unknown;
}
export interface SitePage {
  contacts: SiteContact[];
  facts: SiteFact[];
  text: string;
  links: string[];
  spa: boolean;
  challenge: string | null;
}
interface SiteContext {
  url: string;
  country: CountryCode;
}
const priorityPath =
  /contact|kontakt|контакт|about|про[-_ ]?нас|о[-_ ]?нас|rekvizyty|реквізит|impressum|privacy/iu;
const filePath =
  /\.(?:pdf|jpe?g|png|gif|svg|webp|ico|avif|bmp|tiff?|mp[34]|webm|mov|avi|wav|ogg|zip|rar|7z|gz|tar|docx?|xlsx?|pptx?|css|js|xml|json|woff2?|ttf|eot)(?:$|\/)/i;
const messengerKinds = new Set(['telegram', 'whatsapp', 'viber']);
const domain = (hostname: string) =>
  getDomain(hostname, { allowPrivateDomains: true }) ?? hostname.toLowerCase();
const isPriority = (url: string) =>
  priorityPath.test(decodeURIComponent(new URL(url).pathname));

export function sameSiteDomain(homeUrl: string, candidateUrl: string): boolean {
  try {
    return (
      domain(new URL(homeUrl).hostname) ===
      domain(new URL(candidateUrl).hostname)
    );
  } catch {
    return false;
  }
}
export function siteUrl(value: string, homeUrl: string): string | null {
  try {
    const url = new URL(value, homeUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      domain(url.hostname) !== domain(new URL(homeUrl).hostname) ||
      filePath.test(decodeURIComponent(url.pathname))
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
export function orderSiteUrls(
  homeUrl: string,
  homepageLinks: string[],
  sitemapUrls: string[] = [],
): string[] {
  const home = siteUrl(homeUrl, homeUrl);
  const links = homepageLinks
    .map((url) => siteUrl(url, homeUrl))
    .filter((url): url is string => Boolean(url));
  const sitemap = sitemapUrls
    .map((url) => siteUrl(url, homeUrl))
    .filter((url): url is string => Boolean(url) && isPriority(url!));
  return [
    ...new Set([
      ...(home ? [home] : []),
      ...links.filter((url) => isPriority(url)),
      ...sitemap,
      ...links,
    ]),
  ];
}
export function shouldStopSiteScan(
  contacts: SiteContact[],
  pageCount: number,
  maxPages: number,
): boolean {
  return (
    pageCount >= maxPages ||
    (contacts.some((c) => c.kind === 'email') &&
      contacts.some((c) => c.kind === 'phone') &&
      contacts.some((c) => messengerKinds.has(c.kind)))
  );
}
export function robotsAllows(
  text: string,
  pageUrl: string,
  userAgent: string,
): boolean {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let group: (typeof groups)[number] | undefined;
  let rulesStarted = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .replace(/#.*/, '')
      .match(/^\s*(user-agent|allow|disallow)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const [, key, value = ''] = match;
    if (key!.toLowerCase() === 'user-agent') {
      if (!group || rulesStarted) {
        group = { agents: [], rules: [] };
        groups.push(group);
        rulesStarted = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      rulesStarted = true;
      if (value)
        group.rules.push({
          allow: key!.toLowerCase() === 'allow',
          path: value,
        });
    }
  }
  const agent = userAgent.toLowerCase();
  const specificity = Math.max(
    -1,
    ...groups.flatMap((g) =>
      g.agents
        .filter((a) => a !== '*' && agent.includes(a))
        .map((a) => a.length),
    ),
  );
  const url = new URL(pageUrl);
  const path = url.pathname + url.search;
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const specific = groups.filter((g) =>
    g.agents.some(
      (a) => a !== '*' && a.length === specificity && agent.includes(a),
    ),
  );
  return [wildcard, specific].every((selected) => {
    const matches = selected
      .flatMap((g) => g.rules)
      .filter((rule) => {
        const pattern = rule.path
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '.*')
          .replace(/\\\$$/, '$');
        return new RegExp('^' + pattern).test(path);
      })
      .sort(
        (a, b) =>
          b.path.replaceAll('*', '').length -
            a.path.replaceAll('*', '').length ||
          Number(b.allow) - Number(a.allow),
      );
    return matches[0]?.allow ?? true;
  });
}
export function decodeSiteHtml(bytes: Uint8Array, contentType = ''): string {
  const sample = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
  const charset =
    contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ??
    sample.match(/<meta[^>]*charset\s*=\s*["']?([^\s;"'/>]+)/i)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
function emailValues(text: string): string[] {
  const decoded = text
    .replace(
      /\s*(?:\[at\]|\(at\)|\[собака\]|\(собака\)|\sсобака\s|\sat\s)\s*/giu,
      '@',
    )
    .replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/giu, '.');
  return [
    ...decoded.matchAll(
      /[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}/gi,
    ),
  ]
    .map(([email]) => email.toLowerCase())
    .filter(
      (email) =>
        !/@(?:example\.|test\.|yourdomain\.|domain\.|localhost)/i.test(email) &&
        !/\.(?:png|jpe?g|gif|svg|webp|ico|avif)$/i.test(email),
    );
}
export function linkedContact(
  raw: string,
  pageUrl: string,
): SiteContact | null {
  if (/^viber:\/\/(?:chat|add|pa|community|join)(?:[/?]|$)/i.test(raw))
    return { kind: 'viber', value: raw, rank: 70 };
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  if (
    ['t.me', 'telegram.me'].includes(host) &&
    path &&
    !/^\/(?:share|iv|proxy|socks)(?:\/|$)/i.test(path)
  )
    return { kind: 'telegram', value: url.href, rank: 70 };
  if (
    (host === 'wa.me' && /^\/(?:\d+|message\/[^/]+)$/.test(path)) ||
    (host === 'api.whatsapp.com' &&
      path === '/send' &&
      /^\+?\d+$/.test(url.searchParams.get('phone') ?? '')) ||
    (host === 'chat.whatsapp.com' && path.length > 1)
  )
    return { kind: 'whatsapp', value: url.href, rank: 70 };
  if (host === 'invite.viber.com' && (path || url.searchParams.get('g2')))
    return { kind: 'viber', value: url.href, rank: 70 };
  const networks = [
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'youtube.com',
    'tiktok.com',
  ];
  const network = networks.find(
    (name) => host === name || host.endsWith('.' + name),
  );
  if (
    !network ||
    !path ||
    url.searchParams.has('share') ||
    /^\/(?:share|sharer(?:\.php)?|dialog|plugins|watch|reels?|posts?|photos?(?:\.php)?|videos?|story(?:\.php)?|login|groups)(?:\/|$)/i.test(
      path,
    )
  )
    return null;
  const profilePatterns: Record<string, RegExp> = {
    'facebook.com': /^\/(?:[^/]+|pages\/[^/]+\/[^/]+)$/i,
    'instagram.com':
      /^\/(?!p$|reels?$|stories$|explore$|accounts$|direct$)[^/]+$/i,
    'linkedin.com': /^\/(?:company|in|school)\/[^/]+$/i,
    'youtube.com': /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)$/i,
    'tiktok.com': /^\/@[^/]+$/i,
  };
  if (!profilePatterns[network]!.test(path)) return null;
  return {
    kind: 'social',
    value: url.href,
    rank: 40,
    meta: { network: network.split('.')[0] },
  };
}
function fopNames(text: string): string[] {
  const name = "[А-ЯІЇЄҐ][а-яіїєґА-ЯІЇЄҐ'’‘ʼ`-]+";
  const person = new RegExp(
    `^(${name}\\s+(?:[А-ЯІЇЄҐ]\\s*\\.\\s*[А-ЯІЇЄҐ]\\s*\\.|${name}\\s+${name}))(?![\\p{L}'’ʼ-])`,
    'u',
  );
  const found = new Map<string, string>();
  for (const prefix of text.matchAll(
    /(?<!\p{L})(?:ФОП|фізична\s+особа\s*[-–—]\s*підприємець)\s*[:№]?\s+/giu,
  )) {
    const value = text
      .slice(prefix.index + prefix[0].length)
      .match(person)?.[1];
    if (value) found.set(normalizeRegistryName(value), value);
  }
  return [...found.values()];
}
export function extractSitePage(html: string, context: SiteContext): SitePage {
  const $ = load(html);
  const contacts: SiteContact[] = [];
  const facts: SiteFact[] = [];
  const add = (contact: SiteContact) => {
    const existing = contacts.find(
      (c) => c.kind === contact.kind && c.value === contact.value,
    );
    if (!existing) contacts.push(contact);
    else if (contact.rank > existing.rank) Object.assign(existing, contact);
  };
  const addEmail = (value: string) =>
    emailValues(value).forEach((email) =>
      add({
        kind: 'email',
        value: email,
        rank:
          domain(email.split('@')[1]!) === domain(new URL(context.url).hostname)
            ? 100
            : 60,
      }),
    );
  const addPhone = (value: string, rank: number) => {
    const phone = normalizePhone(
      value.replace(/^tel:/i, '').split(';')[0]!,
      context.country,
    );
    if (phone && !placeholderPhone(phone))
      add({ kind: 'phone', value: phone, rank });
  };
  const schemas: unknown[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    const types = Array.isArray(node['@type'])
      ? node['@type']
      : [node['@type']];
    if (
      types.some(
        (type) =>
          typeof type === 'string' &&
          /(?:Organization|LocalBusiness|AutomotiveBusiness|AutoRepair|Store|Restaurant|ProfessionalService)$/i.test(
            type,
          ),
      )
    ) {
      schemas.push(node);
      for (const email of [node.email].flat())
        if (typeof email === 'string') addEmail(email);
      for (const phone of [node.telephone].flat())
        if (typeof phone === 'string') addPhone(phone, 100);
      for (const link of [node.sameAs].flat())
        if (typeof link === 'string') {
          const contact = linkedContact(link, context.url);
          if (contact) add(contact);
        }
    }
    Object.values(node).forEach(visit);
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch {
      /* Ignore invalid publisher JSON. */
    }
  });
  if (schemas.length) facts.push({ kind: 'schema_org', value: schemas });
  const links: string[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')!.trim();
    if (/^mailto:/i.test(href)) {
      try {
        addEmail(decodeURIComponent(href.slice(7).split('?')[0]!));
      } catch {
        /* Ignore malformed encoding. */
      }
    } else if (/^tel:/i.test(href)) {
      try {
        addPhone(decodeURIComponent(href), 100);
      } catch {
        /* Ignore malformed encoding. */
      }
    } else {
      const contact = linkedContact(href, context.url);
      if (contact) add(contact);
      const url = siteUrl(href, context.url);
      if (url) links.push(url);
    }
  });
  const captcha = /(?:g-recaptcha|google\.com\/recaptcha|recaptcha\.net)/i.test(
    html,
  )
    ? /[?&]render=(?!explicit(?:[&"'\s]|$))[^&"'\s>]+/i.test(html)
      ? 'recaptcha_v3'
      : 'recaptcha_v2'
    : /h-captcha|hcaptcha\.com/i.test(html)
      ? 'hcaptcha'
      : /cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(html)
        ? 'turnstile'
        : 'none';
  $('form').each((_, form) => {
    const fields = $(form)
      .find('input,textarea,select')
      .map((_, field) =>
        [
          $(field).attr('name'),
          $(field).attr('type'),
          $(field).attr('placeholder'),
          $(field).attr('id'),
        ].join(' '),
      )
      .get()
      .join(' ');
    const identities = [
      /(?:name|ім.?я|имя)/i,
      /(?:email|e-mail)/i,
      /(?:phone|tel|тел)/i,
    ].filter((pattern) => pattern.test(fields)).length;
    if (/(?:message|повідом|сообщ)/i.test(fields) || identities >= 2)
      add({ kind: 'form', value: context.url, rank: 30, meta: { captcha } });
  });
  if (contacts.some((contact) => contact.kind === 'form'))
    facts.push({ kind: 'captcha', value: captcha });
  const lang = $('html').attr('lang')?.trim().split(/[-_]/)[0]?.toLowerCase();
  const title = $('title,h1').text();
  const spa =
    /(?:id=["'](?:root|app|__next)["']|__NEXT_DATA__|ng-version|data-reactroot)/i.test(
      html,
    ) && $('script').length > 0;
  $('script,style,noscript,template,svg').remove();
  $('body').find('p,div,li,td,section,footer,header,br,h1,h2,h3').append(' ');
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  for (const value of fopNames(text)) facts.push({ kind: 'fop_name', value });
  addEmail(text);
  const phoneText = text
    .replace(
      /(?:ЄДРПОУ|ЕДРПОУ|ІПН|ИНН|РНОКПП|код)\s*[:№#-]?\s*\d[\d -]{6,14}\d/giu,
      ' ',
    )
    .replace(
      /\b(?:\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}|(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2})\b/g,
      ' ',
    );
  for (const match of findPhoneNumbersInText(phoneText, context.country))
    addPhone(match.number.number, 60);
  for (const [kind, pattern] of [
    ['edrpou', /(?:ЄДРПОУ|ЕДРПОУ|код)\s*[:№#-]?\s*(\d{8})(?!\d)/giu],
    ['ipn', /(?:ІПН|ИНН|РНОКПП)\s*[:№#-]?\s*(\d{10})(?!\d)/giu],
  ] as const)
    for (const match of text.matchAll(pattern))
      facts.push({ kind, value: match[1] });
  const language =
    lang ||
    (/[іїєґ]/iu.test(text)
      ? 'uk'
      : /[ыэёъ]/iu.test(text)
        ? 'ru'
        : /[ąćęłńóśźż]/iu.test(text)
          ? 'pl'
          : /[äöüß]/iu.test(text)
            ? 'de'
            : /[a-z]/i.test(text)
              ? 'en'
              : null);
  if (language) facts.push({ kind: 'language', value: language });
  const challenge =
    /(?:\/cdn-cgi\/challenge-platform|cf-chl-|cf-browser-verification)/i.test(
      html,
    ) || /just a moment|attention required.*cloudflare/i.test(title)
      ? 'cloudflare'
      : /(?:verify (?:that )?you are human|підтвердьте.{0,20}людина|checking your browser)/i.test(
            title,
          )
        ? 'captcha'
        : captcha !== 'none' &&
            !contacts.some((c) => c.kind === 'form') &&
            /captcha|security check|verify|human|robot/i.test(
              title + ' ' + text,
            )
          ? 'captcha'
          : null;
  return {
    contacts,
    facts,
    text,
    links: [...new Set(links)],
    spa: text.length < 200 && spa,
    challenge,
  };
}
export const aiSiteResultSchema = z
  .object({
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    messengers: z.array(z.string()),
    edrpou: z.union([z.string(), z.array(z.string()), z.null()]),
  })
  .strict();
export function normalizeAiSiteResult(
  value: unknown,
  context: SiteContext,
): Pick<SitePage, 'contacts' | 'facts'> | null {
  let data: unknown = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = aiSiteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const contacts: SiteContact[] = [];
  const add = (contact: SiteContact) => {
    if (
      !contacts.some(
        (c) => c.kind === contact.kind && c.value === contact.value,
      )
    )
      contacts.push({ ...contact, meta: { ...contact.meta, ai: true } });
  };
  parsed.data.emails.forEach((email) =>
    emailValues(email).forEach((value) =>
      add({
        kind: 'email',
        value,
        rank:
          domain(value.split('@')[1]!) === domain(new URL(context.url).hostname)
            ? 100
            : 60,
      }),
    ),
  );
  parsed.data.phones.forEach((raw) => {
    const value = normalizePhone(raw, context.country);
    if (value && !placeholderPhone(value))
      add({ kind: 'phone', value, rank: 50 });
  });
  parsed.data.messengers.forEach((raw) => {
    const contact = linkedContact(raw, context.url);
    if (contact && messengerKinds.has(contact.kind)) add(contact);
  });
  const facts = [
    ...new Set(
      [parsed.data.edrpou]
        .flat()
        .filter(
          (value): value is string =>
            typeof value === 'string' && /^\d{8}$/.test(value),
        ),
    ),
  ].map((value) => ({ kind: 'edrpou', value }));
  return { contacts, facts };
}
// Template sites ship demo numbers such as +380671234567 or +380000000000.
export function placeholderPhone(e164: string): boolean {
  const digits = e164.replace(/\D/g, '');
  const tail = digits.slice(-7);
  return (
    /^(\d)\1{6}$/.test(tail) ||
    '0123456789'.includes(tail) ||
    '9876543210'.includes(tail)
  );
}
