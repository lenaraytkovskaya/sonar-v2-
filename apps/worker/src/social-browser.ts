import {
  chromium,
  type Browser,
  type APIRequestContext,
  type BrowserContext,
} from 'playwright';
import { type SocialTarget } from '@sonar/core';
import { socialProxyList } from '@sonar/core/social-session';
export type SocialProxy = {
  server: string;
  username?: string;
  password?: string;
};
export type SocialPage = {
  usedProxy?: boolean;
  html: string;
  url: string;
  status: number;
  error?: 'robots_denied' | 'robots_unavailable' | 'network_error';
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
      proxy,
      userAgent,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
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
