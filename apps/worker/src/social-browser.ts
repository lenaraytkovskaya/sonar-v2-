import {
  chromium,
  type Browser,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from 'playwright';
import { detectSocialBlock, type SocialTarget } from '@sonar/core';
import {
  socialProxyList,
  type resolveSocialSession,
} from '@sonar/core/social-session';
import { assertSocialSession } from './social-send-browser.js';
export type SocialProxy = {
  server: string;
  username?: string;
  password?: string;
};
export type SocialPage = {
  usedProxy?: boolean;
  proxyUnits?: number;
  html: string;
  url: string;
  status: number;
  documents?: { url: string; html: string }[];
  error?:
    | 'robots_denied'
    | 'robots_unavailable'
    | 'network_error'
    | 'session_invalid';
};
let sharedBrowser: Promise<Browser> | undefined;
export async function closeSocialBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  if (browser) await (await browser).close();
}
export function socialProxies(value = socialProxyList()): SocialProxy[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(part);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        return {
          server: url.origin,
          ...(url.username
            ? { username: decodeURIComponent(url.username) }
            : {}),
          ...(url.password
            ? { password: decodeURIComponent(url.password) }
            : {}),
        };
      } catch {
        throw new Error('Некоректне налаштування SOCIAL_PROXY_URLS');
      }
    });
}
export async function fetchSocialPage(
  target: SocialTarget,
  proxy: SocialProxy,
  timeoutMs: number,
  userAgent: string,
  session?: ReturnType<typeof resolveSocialSession>,
): Promise<SocialPage> {
  const empty = (error: SocialPage['error']): SocialPage => ({
    html: '',
    url: target.canonicalUrl,
    status: 0,
    error,
    usedProxy,
  });
  let context: BrowserContext | undefined;
  let usedProxy = false;
  try {
    // A dead default proxy prevents accidental direct browser traffic outside contexts.
    const browser = await (sharedBrowser ??= chromium
      .launch({
        headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      })
      .catch(() => {
        sharedBrowser = undefined;
        throw new Error('Не вдалося запустити браузер соцмереж.');
      }));
    context = await browser.newContext({
      proxy: session?.proxy ?? proxy,
      userAgent,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    if (session) await context.addCookies(session.cookies);
    if (session) {
      // All resource traffic uses the pinned context proxy. Only the platform and its
      // static CDNs are allowed; external links and local-network redirects stay blocked.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const hosts = [
          `${target.network}.com`,
          ...{
            instagram: ['cdninstagram.com', 'fbcdn.net'],
            facebook: ['fbcdn.net', 'fbsbx.com'],
            linkedin: ['licdn.com'],
          }[target.network],
        ];
        const allowed =
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          hosts.some(
            (host) =>
              url.hostname === host || url.hostname.endsWith(`.${host}`),
          );
        if (
          !allowed ||
          (route.request().isNavigationRequest() &&
            url.origin !== new URL(target.canonicalUrl).origin)
        )
          return route.abort();
        usedProxy = true;
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await page.routeWebSocket('**/*', (socket) => socket.close());
      return {
        ...(await renderSocialDocuments(page, target, timeoutMs)),
        usedProxy,
      };
    }
    usedProxy = true;
    const result = await readSocialDocuments(
      context.request,
      target,
      timeoutMs,
      userAgent,
    );
    if (result.error || result.status >= 400) return { ...result, usedProxy };
    // Render only the received public document; every browser request stays blocked.
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setContent(result.html, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    return { ...result, usedProxy, html: await page.content() };
  } catch {
    return empty('network_error');
  } finally {
    await context?.close().catch(() => {});
  }
}

export function socialDocumentUrls(
  target: SocialTarget,
  hrefs: string[],
): string[] {
  const base = new URL(target.canonicalUrl);
  if (target.network === 'instagram') {
    const urls: string[] = [];
    for (const href of hrefs) {
      try {
        const url = new URL(href, base);
        if (
          url.origin !== base.origin ||
          !/^\/(?:p|reel)\/[A-Za-z0-9_-]+\/$/.test(url.pathname)
        )
          continue;
        url.search = '';
        url.hash = '';
        if (!urls.includes(url.href)) urls.push(url.href);
      } catch {
        /* Ignore malformed profile links. */
      }
      if (urls.length === 4) break;
    }
    return urls;
  }
  if (target.network === 'facebook') {
    if (base.pathname === '/profile.php') {
      base.searchParams.set('sk', 'about_contact_and_basic_info');
      return [base.href];
    }
    return [
      new URL(
        `${base.pathname.replace(/\/$/, '')}/about_contact_and_basic_info/`,
        base,
      ).href,
    ];
  }
  return ['about/', 'posts/'].map(
    (path) =>
      new URL(path, base.href.endsWith('/') ? base : `${base.href}/`).href,
  );
}
export async function renderSocialDocuments(
  page: Page,
  target: SocialTarget,
  timeoutMs: number,
): Promise<SocialPage> {
  let proxyUnits = 0;
  const read = async (url: string) => {
    proxyUnits++;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      // Give scripts a bounded opportunity to render profile sections and the post grid.
      await page
        .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 3000) })
        .catch(() => {});
      let html = await page.content();
      const status = response?.status() ?? 0;
      if (!detectSocialBlock(html, page.url(), status, target)) {
        await page.evaluate(() => window.scrollBy(0, 650));
        await page
          .waitForLoadState('networkidle', {
            timeout: Math.min(timeoutMs, 1500),
          })
          .catch(() => {});
        html = await page.content();
      }
      return { html, url: page.url(), status };
    } catch {
      return { html: '', url, status: 0, error: 'network_error' as const };
    }
  };
  const initial = await read(target.canonicalUrl);
  if (
    initial.error ||
    detectSocialBlock(initial.html, initial.url, initial.status, target) ||
    initial.status >= 400
  )
    return { ...initial, proxyUnits };
  try {
    await assertSocialSession(page, target.network);
  } catch {
    return { ...initial, proxyUnits, error: 'session_invalid' };
  }
  // Instagram profile-grid links identify the profile's own posts. The parser also
  // checks post ownership before using their dates; pinned links are not date ordering.
  const hrefs =
    target.network === 'instagram'
      ? await page
          .locator('main a[href*="/p/"], main a[href*="/reel/"]')
          .evaluateAll((links) =>
            links
              .filter((link) => !link.closest('aside,nav'))
              .map((link) => link.getAttribute('href') ?? ''),
          )
      : [];
  const documents: { url: string; html: string }[] = [];
  for (const url of socialDocumentUrls(target, hrefs)) {
    const document = await read(url);
    if (
      document.error ||
      detectSocialBlock(document.html, document.url, document.status, target)
    )
      return { ...document, documents, proxyUnits };
    try {
      await assertSocialSession(page, target.network);
    } catch {
      return { ...document, documents, proxyUnits, error: 'session_invalid' };
    }
    if (document.status < 400 && document.status > 0)
      documents.push({ url: document.url, html: document.html });
  }
  return { ...initial, documents, proxyUnits };
}
export async function readSocialDocuments(
  request: Pick<APIRequestContext, 'get'>,
  target: SocialTarget,
  timeoutMs: number,
  userAgent: string,
): Promise<SocialPage> {
  const empty = (error: SocialPage['error']): SocialPage => ({
    html: '',
    url: target.canonicalUrl,
    status: 0,
    error,
  });
  const origin = new URL(target.canonicalUrl).origin;
  const options = { timeout: timeoutMs, maxRedirects: 0 };
  // Owner decision (13.11.2026): public company pages are read regardless of the networks'
  // robots.txt. Login walls, CAPTCHA and rate limits still stop the request (see social.ts).
  void userAgent;
  let url = new URL(target.canonicalUrl);
  for (let index = 0; index < 2; index++) {
    if (url.origin !== origin || url.username || url.password)
      return empty('network_error');
    const response = await request.get(url.href, options);
    if ([301, 302, 303, 307, 308].includes(response.status())) {
      const location = response.headers().location;
      if (!location) return empty('network_error');
      url = new URL(location, url);
      continue;
    }
    return {
      html: await response.text(),
      url: url.href,
      status: response.status(),
    };
  }
  return empty('network_error');
}
