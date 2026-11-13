import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { SocialSendError } from '@sonar/core/social-session';
import { socialTarget, type SocialNetwork } from '@sonar/core';
import type { socialProxies } from './social-browser.js';

export type SocialSessionAccount = {
  id: string;
  channel: SocialNetwork;
  settings: Record<string, unknown>;
};
export type SocialBrowserSession = {
  cookies: Parameters<BrowserContext['addCookies']>[0];
  proxy: ReturnType<typeof socialProxies>[number];
};
const home = (network: SocialNetwork) => `https://www.${network}.com/`;
const messageLabel =
  /^(?:message|send message|повідомлення|надіслати повідомлення|сообщение|отправить сообщение)$/i;
const sendLabel = /^(?:send|надіслати|отправить)$/i;
const outgoing = {
  instagram:
    '[role="row"]:has([style*="align-items: flex-end"]), [role="row"]:has([style*="align-self: flex-end"]), [aria-label^="You sent"], [aria-label^="Ви надіслали"]',
  facebook:
    '[aria-label^="You sent"], [aria-label^="Ви надіслали"], [aria-label^="Вы отправили"]',
  linkedin:
    '.msg-s-message-list__event--own, .msg-s-message-list__event--is-from-me',
};
function failure(
  code: 'session_invalid' | 'unavailable' | 'delivery_uncertain',
) {
  return new SocialSendError(
    code,
    {
      session_invalid: 'Увійдіть знову (оновіть cookies)',
      unavailable:
        'Надсилання цій сторінці недоступне або тип сторінки не підтверджено.',
      delivery_uncertain: 'Перевірте чат вручну',
    }[code],
  );
}
export async function assertSocialSession(page: Page, network: SocialNetwork) {
  const url = new URL(page.url());
  if (
    !url.hostname.endsWith(`.${network}.com`) &&
    url.hostname !== `${network}.com` &&
    !(network === 'facebook' && /^(www\.)?messenger\.com$/.test(url.hostname))
  )
    throw failure('session_invalid');
  if (
    /login|signin|checkpoint|challenge|captcha|authwall|security\/verification/i.test(
      url.pathname,
    ) ||
    (await page
      .locator(
        'input[type="password"], iframe[src*="captcha"], [data-testid="captcha"], form[action*="checkpoint"], [aria-label*="Confirm you"], [aria-label*="Підтвердьте"]',
      )
      .count())
  )
    throw failure('session_invalid');
  if (
    await page
      .getByText(
        /^(?:Confirm it.s you|Confirm your identity|Підтвердьте свою особу|Підтвердіть, що це ви|Подтвердите, что это вы)$/i,
      )
      .count()
  )
    throw failure('session_invalid');
  const authenticated = {
    instagram: 'a[href^="/direct/"], a[href="/accounts/edit/"]',
    facebook:
      '[aria-label="Your profile"], [aria-label="Ваш профіль"], [aria-label="Account"], a[href*="/me/"], a[href*="/messages/t/"]',
    linkedin:
      'a[href*="/messaging/"], button.global-nav__primary-link-me-menu-trigger',
  }[network];
  try {
    await page.locator(authenticated).first().waitFor({ state: 'visible' });
  } catch {
    throw failure('session_invalid');
  }
}
async function confirmedDialogUrl(page: Page, network: SocialNetwork) {
  const valid = (raw: string | null) => {
    if (!raw) return null;
    try {
      const url = new URL(raw, page.url());
      if (url.protocol !== 'https:' || url.username || url.password)
        return null;
      const host = url.hostname.replace(/^www\./, '');
      const matches =
        network === 'instagram'
          ? host === 'instagram.com' &&
            /^\/direct\/t\/[^/]+\/?$/.test(url.pathname)
          : network === 'facebook'
            ? (host === 'facebook.com' &&
                /^\/messages\/t\/[^/]+\/?$/.test(url.pathname)) ||
              (host === 'messenger.com' && /^\/t\/[^/]+\/?$/.test(url.pathname))
            : host === 'linkedin.com' &&
              /^\/messaging\/thread\/[^/]+\/?$/.test(url.pathname);
      if (!matches) return null;
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };
  const current = valid(page.url());
  if (current) return current;
  // Overlay headers must identify this active conversation, never a sidebar thread.
  const links = page.locator(
    '[role="dialog"]:has([contenteditable="true"]) a[href*="/thread/"], .msg-overlay-conversation-bubble--is-active a[href*="/messaging/thread/"]',
  );
  if ((await links.count()) === 1) {
    const link = valid(await links.getAttribute('href'));
    if (link) return link;
  }
  throw failure('delivery_uncertain');
}
export function createSocialSendBrowser(
  launch = () =>
    chromium.launch({
      headless: true,
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }),
) {
  let browser: Promise<Browser> | undefined;
  const contexts = new Map<string, { key: string; context: BrowserContext }>();
  const pending = new Map<string, Promise<unknown>>();
  async function serialized<T>(id: string, operation: () => Promise<T>) {
    const previous = pending.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    pending.set(id, result);
    try {
      return await result;
    } finally {
      if (pending.get(id) === result) pending.delete(id);
    }
  }
  async function withPage<T>(
    account: SocialSessionAccount,
    session: SocialBrowserSession,
    timeoutMs: number,
    fn: (page: Page) => Promise<T>,
  ) {
    return serialized(account.id, async () => {
      const key = JSON.stringify([
        account.channel,
        account.settings.cookiesEncrypted,
        session.proxy,
      ]);
      let cached = contexts.get(account.id);
      if (cached?.key !== key) {
        await cached?.context.close();
        contexts.delete(account.id);
        browser ??= launch().catch(() => {
          browser = undefined;
          throw failure('session_invalid');
        });
        const context = await (
          await browser
        ).newContext({
          proxy: session.proxy,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        try {
          await context.addCookies(session.cookies);
        } catch {
          await context.close().catch(() => {});
          throw failure('session_invalid');
        }
        cached = { key, context };
        contexts.set(account.id, cached);
      }
      const page = await cached.context.newPage();
      page.setDefaultTimeout(timeoutMs);
      try {
        return await fn(page);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }
  return {
    async check(
      account: SocialSessionAccount,
      session: SocialBrowserSession,
      timeoutMs: number,
    ) {
      return withPage(account, session, timeoutMs, async (page) => {
        await page.goto(home(account.channel), {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        await assertSocialSession(page, account.channel);
      });
    },
    async send(
      account: SocialSessionAccount,
      session: SocialBrowserSession,
      timeoutMs: number,
      to: string,
      body: string,
      beforeSend: () => Promise<void>,
    ) {
      const target = socialTarget(to);
      if (
        !target ||
        target.network !== account.channel ||
        (target.network === 'linkedin' && target.kind !== 'company') ||
        target.kind === 'unsupported'
      )
        throw failure('unavailable');
      let attempted = false;
      try {
        return await withPage(account, session, timeoutMs, async (page) => {
          await page.goto(target.canonicalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });
          await assertSocialSession(page, account.channel);
          if (
            account.channel === 'facebook' &&
            !(await page.locator('a[href*="page_transparency"]').count()) &&
            !(await page
              .getByText(
                /^(?:Page transparency|Прозорість сторінки|Прозрачность страницы)$/i,
              )
              .count())
          )
            throw failure('unavailable');
          if (
            account.channel === 'instagram' ||
            account.channel === 'facebook'
          ) {
            await page.goto(
              account.channel === 'instagram'
                ? `https://ig.me/m/${encodeURIComponent(target.handle)}`
                : `https://m.me/${encodeURIComponent(target.handle)}`,
              { waitUntil: 'domcontentloaded', timeout: timeoutMs },
            );
          } else {
            const messageButton = page
              .getByRole('button', { name: messageLabel })
              .first();
            if (!(await messageButton.isVisible()))
              throw new SocialSendError(
                'unavailable',
                'Сторінка LinkedIn не приймає повідомлень',
              );
            await messageButton.click();
          }
          await assertSocialSession(page, account.channel);
          const composer = page
            .locator(
              '[contenteditable="true"][role="textbox"], textarea[placeholder]',
            )
            .last();
          await composer.fill(body);
          const ownMessages = page
            .locator(outgoing[account.channel])
            .filter({ has: page.getByText(body, { exact: true }) });
          const count = await ownMessages.count();
          await beforeSend();
          attempted = true;
          try {
            if (account.channel === 'instagram') await composer.press('Enter');
            else
              await page
                .getByRole('button', { name: sendLabel })
                .last()
                .click();
          } catch {
            await assertSocialSession(page, account.channel);
            throw failure('delivery_uncertain');
          }
          try {
            await ownMessages
              .nth(count)
              .waitFor({ state: 'visible', timeout: timeoutMs });
          } catch {
            await assertSocialSession(page, account.channel);
            throw failure('delivery_uncertain');
          }
          await assertSocialSession(page, account.channel);
          return confirmedDialogUrl(page, account.channel);
        });
      } catch (error) {
        if (
          error instanceof SocialSendError &&
          error.code === 'session_invalid'
        )
          throw error;
        if (attempted) throw failure('delivery_uncertain');
        if (error instanceof SocialSendError) throw error;
        throw failure('unavailable');
      }
    },
    async close() {
      await Promise.allSettled([...pending.values()]);
      await Promise.allSettled(
        [...contexts.values()].map((value) => value.context.close()),
      );
      contexts.clear();
      if (browser) await (await browser).close();
      browser = undefined;
    },
  };
}
export const socialSendBrowser = createSocialSendBrowser();
