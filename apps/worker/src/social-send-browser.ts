import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
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
// Unsupported or ambiguous markup must fail closed rather than guess an ellipsis.
const profileOptionsLabel =
  /^(?:options|more options|параметри|додаткові параметри|опції|настройки)$/i;
const menuMessageLabel =
  /^(?:send message|надіслати повідомлення|отправить сообщение)$/i;
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
type SendStage =
  | 'navigation'
  | 'session'
  | 'profile'
  | 'messagebutton'
  | 'dialog'
  | 'composer'
  | 'attempt'
  | 'confirmation';
type SendErrorKind =
  | 'timeout'
  | 'restricted'
  | 'http_429'
  | 'http_error'
  | 'mismatch'
  | 'unconfirmed'
  | 'unexpected';
function stagedFailure(
  stage: SendStage,
  errorKind: SendErrorKind,
  code: SocialSendError['code'] = 'unavailable',
) {
  const reason =
    code === 'rate_limit'
      ? 'Instagram обмежив частоту запитів. Акаунт призупинено; перевірте обмеження перед ручним відновленням.'
      : {
          navigation: 'Не вдалося відкрити сторінку Instagram.',
          session:
            'Сесію Instagram не підтверджено. Перевірте вхід та обмеження акаунта.',
          profile: 'Профіль одержувача Instagram не підтверджено.',
          messagebutton:
            'Кнопку «Повідомлення» у профілі Instagram не підтверджено.',
          dialog: 'Діалог Instagram з потрібним одержувачем не підтверджено.',
          composer:
            'Поле повідомлення в підтвердженому діалозі Instagram недоступне або неоднозначне.',
          attempt: 'Не вдалося підтвердити безпечну спробу надсилання.',
          confirmation:
            'Доставку Instagram не підтверджено. Перевірте чат вручну; не повторюйте надсилання автоматично.',
        }[stage];
  // Only allowlisted stage/kind values are retained, never Playwright messages or URLs.
  return Object.assign(
    new SocialSendError(code, `[${stage}/${errorKind}] ${reason}`),
    { stage, errorKind },
  );
}
async function messageButtonFailure(
  branch: 'preexisting_popup' | 'options_count',
  page: Page,
  options: Locator,
) {
  const error = stagedFailure('messagebutton', 'unconfirmed');
  const [menus, dialogs, optionCount] = await Promise.all([
    page.locator('[role="menu"]:visible').count(),
    page.locator('[role="dialog"]:visible').count(),
    options.count(),
  ]);
  // Bounded DOM counts and fixed keys only; never retain accessible names/text.
  const count = (value: number) => (value > 1 ? '2+' : String(value));
  error.reasonUk += ` [branch=${branch}; menus=${count(menus)}; dialogs=${count(dialogs)}; options=${count(optionCount)}]`;
  error.message = error.reasonUk;
  return error;
}
const composerLabel =
  /^(?:message|повідомлення|сообщение|написати повідомлення|напишіть повідомлення|написать сообщение)(?:…|\.{3})?$/i;
const conversationHeaders =
  ':is(header, [role="banner"]):visible:not(:is(aside, nav, [role="complementary"], [role="navigation"]) *)';
async function instagramDialog(page: Page, handle: string) {
  await page.waitForURL(
    /^https:\/\/(?:www\.)?instagram\.com\/direct\/t\/[^/?#]+\/?(?:[?#].*)?$/,
  );
  // Only the innermost visible conversation boundary may own its header/composer.
  // Ancestor headers, sidebar links and hidden recipients cannot identify a chat.
  const boundaries =
    ':is([role="dialog"], main, [role="main"]):visible:not(:is(aside, nav, [role="complementary"], [role="navigation"]) *)';
  const containers = page
    .locator(boundaries)
    .filter({ hasNot: page.locator(boundaries) });
  const recipient = page
    .locator(conversationHeaders)
    .locator(
      `a:visible:is([href="/${handle}/" i], [href="https://www.instagram.com/${handle}/" i], [href="https://instagram.com/${handle}/" i])`,
    );
  const matching = containers.filter({ has: recipient });
  if ((await matching.count()) > 1)
    throw stagedFailure('dialog', 'unconfirmed');
  await matching.waitFor({ state: 'visible' });
  if ((await containers.count()) !== 1)
    throw stagedFailure('dialog', 'unconfirmed');
  const dialog = containers;
  const headers = dialog.locator(conversationHeaders);
  if ((await headers.count()) !== 1)
    throw stagedFailure('dialog', 'unconfirmed');
  const links = await headers
    .locator('a[href]:visible')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('href')),
    );
  for (const href of links) {
    const profile = href && socialTarget(new URL(href, page.url()).href);
    if (
      profile &&
      profile.network === 'instagram' &&
      profile.kind !== 'unsupported' &&
      profile.handle !== handle
    )
      throw stagedFailure('dialog', 'mismatch');
  }
  return dialog;
}
async function sendInstagram(
  page: Page,
  target: { canonicalUrl: string; handle: string },
  timeoutMs: number,
  body: string,
  beforeSend: () => Promise<void>,
) {
  let stage: SendStage = 'navigation';
  let attempted = false;
  let restriction: 'session_invalid' | 'rate_limit' | undefined;
  page.on('response', (response) => {
    if (![401, 403, 429].includes(response.status())) return;
    const request = response.request();
    const url = new URL(response.url());
    const document =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const directApi =
      ['xhr', 'fetch'].includes(request.resourceType()) &&
      /^\/api\/v1\/(?:direct\/|accounts\/current_user\/)/.test(url.pathname);
    if (url.origin !== 'https://www.instagram.com' || (!document && !directApi))
      return;
    if (response.status() !== 429) restriction = 'session_invalid';
    else restriction ??= 'rate_limit';
  });
  const assertSession = async () => {
    const previous = stage;
    stage = 'session';
    if (restriction)
      throw stagedFailure(
        stage,
        restriction === 'rate_limit' ? 'http_429' : 'restricted',
        restriction,
      );
    await assertSocialSession(page, 'instagram');
    if (
      await page
        .locator('[role="alert"], [role="alertdialog"]')
        .filter({
          hasText:
            /^(?:Try again later|Too many requests|Забагато запитів|Спробуйте пізніше|Слишком много запросов|Попробуйте позже)$/i,
        })
        .count()
    )
      throw stagedFailure('session', 'restricted', 'rate_limit');
    stage = previous;
  };
  try {
    const response = await page.goto(target.canonicalUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    if (response && response.status() >= 400)
      throw stagedFailure(
        stage,
        response.status() === 429 ? 'http_429' : 'http_error',
        response.status() === 429
          ? 'rate_limit'
          : [401, 403].includes(response.status())
            ? 'session_invalid'
            : 'unavailable',
      );
    await assertSession();
    stage = 'profile';
    if (
      socialTarget(page.url())?.canonicalUrl.toLowerCase() !==
      target.canonicalUrl.toLowerCase()
    )
      throw stagedFailure(stage, 'mismatch');
    const name = new RegExp(
      `^${target.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'i',
    );
    const profile = page
      .locator('main header, [role="main"] header')
      .filter({ has: page.getByRole('heading', { name }) });
    await profile.waitFor({ state: 'visible' });
    stage = 'messagebutton';
    const directAction = page
      .getByRole('button', { name: messageLabel })
      .or(page.getByRole('link', { name: messageLabel }))
      .filter({ visible: true });
    const optionsAction = page
      .getByRole('button', { name: profileOptionsLabel })
      .filter({ visible: true });
    await profile
      .filter({ has: directAction.or(optionsAction) })
      .waitFor({ state: 'visible' });
    const direct = profile.locator(directAction);
    if (await direct.count()) await direct.click();
    else {
      // A portal is outside the verified header. Require a newly visible, unique
      // popup after clicking that header's own options, never a pre-existing menu.
      const popup = page.locator(
        '[role="menu"]:visible, [role="dialog"]:visible',
      );
      const options = profile.locator(optionsAction);
      if (await popup.count())
        throw await messageButtonFailure('preexisting_popup', page, options);
      if ((await options.count()) !== 1)
        throw await messageButtonFailure('options_count', page, options);
      await options.click();
      await popup.waitFor({ state: 'visible' });
      await assertSession();
      if (
        socialTarget(page.url())?.canonicalUrl.toLowerCase() !==
        target.canonicalUrl.toLowerCase()
      )
        throw stagedFailure(stage, 'mismatch');
      await popup
        .getByRole('menuitem', { name: menuMessageLabel })
        .or(popup.getByRole('button', { name: menuMessageLabel }))
        .or(popup.getByRole('link', { name: menuMessageLabel }))
        .filter({ visible: true })
        .click();
    }
    await assertSession();
    stage = 'dialog';
    const dialog = await instagramDialog(page, target.handle);
    const dialogUrl = page.url();
    const dialogNode = await dialog.elementHandle();
    stage = 'composer';
    const composer = dialog
      .getByRole('textbox', { name: composerLabel })
      .or(dialog.getByPlaceholder(composerLabel))
      .filter({ visible: true })
      .and(
        page.locator(
          ':not(:is(aside, nav, header, [role="banner"], [role="complementary"], [role="navigation"]) *)',
        ),
      );
    const composerNode = await composer.elementHandle();
    if (!composerNode) throw stagedFailure(stage, 'unconfirmed');
    await composerNode.fill(body);
    const verifyDialog = async () => {
      await assertSession();
      stage = 'dialog';
      const current = await instagramDialog(page, target.handle);
      if (
        !(await current.evaluate(
          (node, original) => node === original,
          dialogNode,
        )) ||
        page.url() !== dialogUrl
      )
        throw stagedFailure(stage, 'mismatch');
      if (
        !(await composer.evaluate(
          (node, original) => node === original,
          composerNode,
        ))
      )
        throw stagedFailure('composer', 'mismatch');
    };
    const ownMessages = dialog
      .locator(outgoing.instagram)
      .filter({ has: page.getByText(body, { exact: true }) });
    const count = await ownMessages.count();
    await verifyDialog();
    stage = 'attempt';
    await beforeSend();
    attempted = true;
    await verifyDialog();
    stage = 'confirmation';
    await composerNode.press('Enter');
    await ownMessages
      .nth(count)
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await verifyDialog();
    stage = 'confirmation';
    return await confirmedDialogUrl(page, 'instagram');
  } catch (caught) {
    let error = caught;
    if (stage !== 'navigation') {
      try {
        await assertSession();
      } catch (sessionError) {
        error = sessionError;
      }
    }
    const kind =
      (error instanceof Error && error.name === 'TimeoutError') ||
      (error instanceof SocialSendError &&
        'errorKind' in error &&
        error.errorKind === 'timeout')
        ? 'timeout'
        : 'unexpected';
    if (
      error instanceof SocialSendError &&
      ['session_invalid', 'rate_limit'].includes(error.code)
    )
      throw 'stage' in error
        ? error
        : stagedFailure(
            'session',
            kind === 'timeout' ? kind : 'unconfirmed',
            'session_invalid',
          );
    if (attempted || stage === 'attempt')
      throw stagedFailure(stage, kind, 'delivery_uncertain');
    if (error instanceof SocialSendError && 'stage' in error) throw error;
    throw stagedFailure(stage, kind);
  }
}
export async function assertSocialSession(page: Page, network: SocialNetwork) {
  const url = new URL(page.url());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (!url.hostname.endsWith(`.${network}.com`) &&
      url.hostname !== `${network}.com` &&
      !(
        network === 'facebook' && /^(www\.)?messenger\.com$/.test(url.hostname)
      ))
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
  } catch (error) {
    throw Object.assign(failure('session_invalid'), {
      errorKind:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'unconfirmed',
    });
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
        throw account.channel === 'instagram'
          ? stagedFailure('profile', 'unconfirmed')
          : failure('unavailable');
      let attempted = false;
      try {
        return await withPage(account, session, timeoutMs, async (page) => {
          if (account.channel === 'instagram')
            return sendInstagram(page, target, timeoutMs, body, beforeSend);
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
          if (account.channel === 'facebook') {
            await page.goto(
              `https://m.me/${encodeURIComponent(target.handle)}`,
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
            await page.getByRole('button', { name: sendLabel }).last().click();
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
        if (account.channel === 'instagram') {
          if (error instanceof SocialSendError && 'stage' in error) throw error;
          throw stagedFailure('session', 'unexpected', 'session_invalid');
        }
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
