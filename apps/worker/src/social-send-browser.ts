import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright';
import {
  SocialSendError,
  SocialSessionCheckError,
  socialSessionCheckReason,
} from '@sonar/core/social-session';
import { socialTarget, type SocialNetwork } from '@sonar/core';
import type { socialProxies } from './social-browser.js';
import { sendFacebook } from './facebook-send-browser.js';

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
type PopupFailureBranch =
  | 'preexisting_popup'
  | 'options_count'
  | 'options_state'
  | 'popup_missing'
  | 'popup_ambiguous'
  | 'popup_changed'
  | 'popup_association'
  | 'popup_action';
async function messageButtonFailure(
  branch: PopupFailureBranch,
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
const conversationHeaderElements =
  'header, [role="banner"], div[data-pagelet="IGDInboxHeaderOffMsys"]';
// Count nested semantic headers/pagelets once, retaining all their recipient links.
const conversationHeaders = `:is(${conversationHeaderElements}):visible:not(:is(aside, nav, [role="complementary"], [role="navigation"], ${conversationHeaderElements}) *)`;
type DialogPhase = 'initial' | 'after_fill' | 'after_marker' | 'after_send';
function dialogMismatch(
  phase: DialogPhase,
  detail:
    | {
        visibleAnchors: number;
        recognizedProfiles: number;
        mismatchedProfiles: number;
      }
    | { containerChanged: boolean; originalUrl: string; currentUrl: string },
) {
  const error = stagedFailure('dialog', 'mismatch');
  if ('visibleAnchors' in detail) {
    const count = (value: number) => (value > 1 ? '2+' : String(value));
    error.reasonUk += ` [branch=header_recipient_mismatch; phase=${phase}; visible_anchors=${count(detail.visibleAnchors)}; recognized_profiles=${count(detail.recognizedProfiles)}; mismatched_profiles=${count(detail.mismatchedProfiles)}]`;
  } else {
    const original = new URL(detail.originalUrl);
    const current = new URL(detail.currentUrl);
    // Only comparisons leave this function; never retain URL values or identifiers.
    error.reasonUk += ` [branch=${detail.containerChanged ? 'container_changed' : 'dialog_url_changed'}; phase=${phase}; container_changed=${detail.containerChanged}; dialog_url_changed=${detail.currentUrl !== detail.originalUrl}; origin_changed=${current.origin !== original.origin}; path_changed=${current.pathname !== original.pathname}; query_changed=${current.search !== original.search}; hash_changed=${current.hash !== original.hash}]`;
  }
  error.message = error.reasonUk;
  return error;
}
async function instagramDialog(page: Page, handle: string, phase: DialogPhase) {
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
  let recognizedProfiles = 0;
  let mismatchedProfiles = 0;
  for (const href of links) {
    const profile = href && socialTarget(new URL(href, page.url()).href);
    if (
      profile &&
      profile.network === 'instagram' &&
      profile.kind !== 'unsupported'
    ) {
      recognizedProfiles++;
      if (profile.handle !== handle) mismatchedProfiles++;
    }
  }
  if (mismatchedProfiles)
    throw dialogMismatch(phase, {
      visibleAnchors: links.length,
      recognizedProfiles,
      mismatchedProfiles,
    });
  return dialog;
}
function instagramComposer(page: Page, dialog: Locator) {
  return dialog
    .getByRole('textbox', { name: composerLabel })
    .or(dialog.getByPlaceholder(composerLabel))
    .or(
      dialog
        .getByRole('textbox')
        .and(
          dialog.locator(
            '[contenteditable="true"][aria-placeholder="Message..." i]:not([aria-readonly="true"])',
          ),
        ),
    )
    .filter({ visible: true })
    .and(
      page.locator(
        `:not(:is(aside, nav, ${conversationHeaderElements}, [role="complementary"], [role="navigation"]) *)`,
      ),
    );
}
async function instagramArticleConfirmation(dialog: Locator, body: string) {
  return dialog.evaluateHandle((container, body) => {
    const articleSelector = '[role="article"][aria-roledescription="message"]';
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible';
    const localUrl = (anchor: Element) => {
      try {
        const url = new URL(anchor.getAttribute('href')!, location.href);
        return url.origin === location.origin && !url.username && !url.password
          ? url
          : null;
      } catch {
        return null;
      }
    };
    const sender = () => {
      const candidates = Array.from(
        document.querySelectorAll('a[href]'),
      ).filter((anchor) => {
        if (
          !visible(anchor) ||
          anchor.closest(
            'main, [role="main"], [role="dialog"], aside, nav, [role="navigation"], [role="complementary"]',
          )
        )
          return false;
        const url = localUrl(anchor);
        const handle =
          url && /^\/([a-z0-9._]{1,30})\/$/i.exec(url.pathname)?.[1];
        if (
          !url ||
          url.search ||
          url.hash ||
          !handle ||
          !Array.from(anchor.querySelectorAll('img')).some(
            (img) =>
              visible(img) &&
              img.alt.toLowerCase() ===
                `${handle}'s profile picture`.toLowerCase(),
          )
        )
          return false;
        // The observed rail has no semantic nav. Require its known routes
        // together outside every conversation boundary, never a page-wide LCA.
        for (let rail = anchor.parentElement; rail; rail = rail.parentElement) {
          if (rail.querySelector('main, [role="main"], [role="dialog"]'))
            return false;
          const paths = new Set(
            Array.from(rail.querySelectorAll('a[href]'))
              .filter(visible)
              .map(localUrl)
              .filter((link) => link !== null)
              .map((link) => link.pathname),
          );
          if (
            ['/', '/reels/', '/direct/inbox/', '/explore/'].every((p) =>
              paths.has(p),
            )
          )
            return true;
        }
        return false;
      });
      return candidates.length === 1
        ? new URL(candidates[0]!.getAttribute('href')!, location.href).pathname
            .slice(1, -1)
            .toLowerCase()
        : null;
    };
    const expectedSender = sender();
    const lists = container.querySelectorAll(
      '[data-pagelet="IGDMessagesList"]',
    );
    const list = lists.length === 1 ? lists[0]! : null;
    const matching = () =>
      list
        ? Array.from(list.querySelectorAll(articleSelector)).filter(
            (article) => {
              const ids = article
                .getAttribute('aria-labelledby')
                ?.trim()
                .split(/\s+/);
              const labels = ids?.map((id) => document.getElementById(id));
              return (
                visible(article) &&
                labels?.length &&
                labels.every((label) => label && article.contains(label)) &&
                normalize(
                  labels.map((label) => label!.textContent).join(' '),
                ) === normalize(body)
              );
            },
          )
        : [];
    const author = (article: Element) => {
      for (
        let common = article.parentElement;
        common && common !== list;
        common = common.parentElement
      ) {
        if (common.querySelectorAll(articleSelector).length !== 1) return null;
        const groups = common.querySelectorAll(
          '[role="group"][aria-label="Message actions"]',
        );
        if (!groups.length) continue;
        if (groups.length !== 1 || article.contains(groups[0]!)) return null;
        const replies = Array.from(
          groups[0]!.querySelectorAll('[role="button"][aria-label]'),
        )
          .map((control) =>
            /^Reply to message from ([a-z0-9._]{1,30})$/i.exec(
              control.getAttribute('aria-label')!,
            ),
          )
          .filter((match) => match !== null);
        return replies.length === 1 ? replies[0]![1]!.toLowerCase() : null;
      }
      return null;
    };
    let previous = matching();
    let previousArticles: Element[] = [];
    // Unknown old authors also consume the baseline: later hydration must not
    // turn an old exact body into evidence of this send.
    let priorOwn = 0;
    return {
      arm: () => {
        previous = matching();
        previousArticles = list
          ? Array.from(list.querySelectorAll(articleSelector))
          : [];
        priorOwn = previous.filter((article) => {
          const value = author(article);
          return value === null || value === expectedSender;
        }).length;
      },
      confirmed: () => {
        if (
          !expectedSender ||
          sender() !== expectedSender ||
          !list?.isConnected ||
          !container.contains(list)
        )
          return false;
        const current = matching();
        const own = current.filter(
          (article) => author(article) === expectedSender,
        );
        const last = previousArticles.at(-1);
        return (
          current.length > previous.length &&
          own.length > priorOwn &&
          own.some(
            (article) =>
              !previousArticles.includes(article) &&
              (!last ||
                (list.contains(last) &&
                  Boolean(
                    last.compareDocumentPosition(article) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
                  ))),
          )
        );
      },
    };
  }, body);
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
      const options = profile.locator(optionsAction);
      if ((await options.count()) !== 1)
        throw await messageButtonFailure('options_count', page, options);
      // Pin the verified trigger and snapshot identities BEFORE the click. A
      // visible menu is never eligible, even if its contents are replaced later.
      const trigger = await options.elementHandle();
      const profileNode = await profile.elementHandle();
      if (!trigger || !profileNode) throw stagedFailure(stage, 'unconfirmed');
      const snapshot = await trigger.evaluateHandle((node) => {
        const selector = '[role="menu"], [role="dialog"], [role="alertdialog"]';
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(element).visibility !== 'hidden'
          );
        };
        const existing = Array.from(document.querySelectorAll(selector));
        const baseline = existing.filter(visible);
        const role = node.getAttribute('aria-haspopup');
        const expected = role === 'true' ? 'menu' : role;
        const controls = node.getAttribute('aria-controls');
        // Keep only semantics in page memory, never serialized DOM. CSS classes,
        // inline styling and decorative wrappers may change during interaction.
        const semantic = (element: Element) => {
          const text = (value: string | null) =>
            value?.replace(/\s+/g, ' ').trim();
          return JSON.stringify([
            element.tagName,
            element.id,
            element.getAttribute('role'),
            element.getAttribute('href'),
            text(element.textContent),
            [
              element,
              ...Array.from(
                element.querySelectorAll(
                  '[role], [aria-label], [aria-labelledby], [aria-hidden], a[href]',
                ),
              ),
            ].map((label) => [
              label.getAttribute('role'),
              label.getAttribute('href'),
              label.getAttribute('aria-hidden'),
              label.getAttribute('aria-label'),
              label
                .getAttribute('aria-labelledby')
                ?.split(/\s+/)
                .map((id) => {
                  const referenced = document.getElementById(id);
                  return [
                    id,
                    text(referenced?.textContent ?? null),
                    referenced?.getAttribute('aria-label'),
                  ];
                }),
            ]),
          ]);
        };
        const baselineSemantics = baseline.map(semantic);
        let openedPopup: Element | undefined;
        const initial: PopupFailureBranch | null = baseline.some(
          (old) =>
            old.getAttribute('role') !== 'menu' ||
            old.getAttribute('aria-modal') === 'true' ||
            old.contains(node),
        )
          ? 'preexisting_popup'
          : node.getAttribute('aria-expanded') !== 'false' ||
              !['menu', 'dialog'].includes(expected ?? '') ||
              (controls !== null && (!controls || /\s/.test(controls)))
            ? 'options_state'
            : null;
        const candidates = () =>
          Array.from(document.querySelectorAll(selector)).filter(
            (element) => visible(element) && !baseline.includes(element),
          );
        const inspect = (): PopupFailureBranch | 'pending' | 'ready' => {
          if (initial) return initial;
          if (
            baseline.some(
              (old, index) =>
                !old.isConnected ||
                !visible(old) ||
                semantic(old) !== baselineSemantics[index],
            )
          )
            return 'popup_changed';
          if (
            !node.isConnected ||
            node.getAttribute('aria-haspopup') !== role ||
            node.getAttribute('aria-controls') !== controls
          )
            return 'popup_association';
          const opened = candidates();
          if (opened.length > 1) return 'popup_ambiguous';
          if (!opened.length || node.getAttribute('aria-expanded') === 'false')
            return 'pending';
          if (node.getAttribute('aria-expanded') !== 'true')
            return 'popup_association';
          const popup = opened[0]!;
          if (
            popup.getAttribute('role') !== expected ||
            popup.contains(node) ||
            (existing.includes(popup) && controls === null) ||
            (controls !== null &&
              (popup.id !== controls ||
                Array.from(document.querySelectorAll('[id]')).filter(
                  (element) => element.id === controls,
                ).length !== 1))
          )
            return 'popup_association';
          if (openedPopup && openedPopup !== popup) return 'popup_changed';
          openedPopup = popup;
          return 'ready';
        };
        let blocked = false;
        let actionValid = () => true;
        let removeGuard = () => {};
        const guardAction = (popup: Element, action: Element) => {
          const id = popup.id;
          const parent = action.parentElement;
          const approved = semantic(action);
          actionValid = () =>
            inspect() === 'ready' &&
            candidates()[0] === popup &&
            popup.id === id &&
            popup.contains(action) &&
            action.parentElement === parent &&
            visible(action) &&
            !action.matches(':disabled') &&
            action.closest(
              '[aria-disabled="true"], [aria-hidden="true"], [inert]',
            ) === null &&
            semantic(action) === approved;
          const guard = (event: Event) => {
            const onAction = event.composedPath().includes(action);
            if (event.currentTarget === window && !onAction) return;
            blocked ||=
              !onAction ||
              !actionValid() ||
              (event instanceof MouseEvent &&
                !action.contains(
                  document.elementFromPoint(event.clientX, event.clientY),
                ));
            if (blocked) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          };
          const events = [
            'pointerdown',
            'mousedown',
            'pointerup',
            'mouseup',
            'click',
          ];
          // The popup capture boundary runs AFTER document capture (including
          // React handlers), before target/bubble handlers. Window alone is too
          // early. Keep it as well to catch an action moved outside the popup.
          // This is a UI consistency guard, not a sandbox: third-party JS can
          // still change behavior inside its own later/final event handlers.
          for (const boundary of [window, popup])
            for (const event of events)
              boundary.addEventListener(event, guard, {
                capture: true,
                passive: false,
              });
          removeGuard = () => {
            for (const boundary of [window, popup])
              for (const event of events)
                boundary.removeEventListener(event, guard, true);
          };
        };
        return {
          initial,
          inspect,
          candidates,
          guardAction,
          wasBlocked: () => blocked,
          actionValid: () => actionValid(),
          cleanup: () => removeGuard(),
        };
      });
      try {
        const initial = await snapshot.evaluate((state) => state.initial);
        if (initial) throw await messageButtonFailure(initial, page, options);
        await trigger.click();
        try {
          await page.waitForFunction(
            (state) => state.inspect() !== 'pending',
            snapshot,
          );
        } catch {
          throw await messageButtonFailure('popup_missing', page, options);
        }
        await assertSession();
        if (
          socialTarget(page.url())?.canonicalUrl.toLowerCase() !==
            target.canonicalUrl.toLowerCase() ||
          !(await profile.evaluate(
            (node, original) => node === original,
            profileNode,
          )) ||
          (await profile.locator(optionsAction).count()) !== 1 ||
          !(await options.evaluate(
            (node, original) => node === original,
            trigger,
          ))
        )
          throw stagedFailure(stage, 'mismatch');
        const assertPopup = async () => {
          const status = await snapshot.evaluate((state) => state.inspect());
          if (status !== 'ready')
            throw await messageButtonFailure(
              status === 'pending' ? 'popup_missing' : status,
              page,
              options,
            );
        };
        await assertPopup();
        const popup = await snapshot.evaluateHandle(
          (state) => state.candidates()[0]!,
        );
        // Pin identities here; the dispatch guard below also checks provenance
        // after Playwright's actionability wait and document capture handlers.
        const actions = page
          .getByRole('menuitem', { name: menuMessageLabel })
          .or(page.getByRole('button', { name: menuMessageLabel }))
          .or(page.getByRole('link', { name: menuMessageLabel }))
          .filter({ visible: true });
        const handles = await actions.elementHandles();
        const matching = [];
        for (const action of handles) {
          if (
            await popup.evaluate(
              (node, action) => node.contains(action),
              action,
            )
          )
            matching.push(action);
        }
        if (matching.length !== 1)
          throw await messageButtonFailure('popup_action', page, options);
        await assertPopup();
        if (
          !(await actions.evaluateAll(
            (nodes, { state, popup, action }) => {
              const pinned = nodes.find((node) => node === action);
              if (
                state.inspect() !== 'ready' ||
                state.candidates()[0] !== popup ||
                nodes.filter((node) => popup.contains(node)).length !== 1 ||
                !popup.contains(action) ||
                !pinned
              )
                return false;
              state.guardAction(popup, pinned);
              return true;
            },
            { state: snapshot, popup, action: matching[0]! },
          ))
        )
          throw await messageButtonFailure('popup_changed', page, options);
        let clickError: unknown;
        try {
          await matching[0]!.click();
        } catch (error) {
          clickError = error;
        }
        if (
          await snapshot.evaluate(
            (state, failed) =>
              state.wasBlocked() || (failed && !state.actionValid()),
            Boolean(clickError),
          )
        )
          throw await messageButtonFailure('popup_changed', page, options);
        if (clickError) throw clickError;
      } finally {
        await snapshot.evaluate((state) => state.cleanup()).catch(() => {});
        await snapshot.dispose();
      }
    }
    await assertSession();
    stage = 'dialog';
    let dialog = await instagramDialog(page, target.handle, 'initial');
    const dialogUrl = page.url();
    let dialogNode = await dialog.elementHandle();
    stage = 'composer';
    let composerNode = await instagramComposer(page, dialog).elementHandle();
    if (!composerNode) throw stagedFailure(stage, 'unconfirmed');
    await composerNode.fill(body);
    const verifyDialog = async (phase: Exclude<DialogPhase, 'initial'>) => {
      await assertSession();
      stage = 'dialog';
      const current = await instagramDialog(page, target.handle, phase);
      const currentNode = await current.elementHandle();
      if (!currentNode) throw stagedFailure(stage, 'unconfirmed');
      const containerChanged = !(await currentNode.evaluate(
        (node, original) => node === original,
        dialogNode,
      ));
      const currentUrl = page.url();
      // A rerender before the durable attempt may replace the entire subtree.
      // After the marker, keep the pinned nodes and never rebind or send again.
      if (
        (containerChanged && phase !== 'after_fill') ||
        currentUrl !== dialogUrl
      )
        throw dialogMismatch(phase, {
          containerChanged,
          originalUrl: dialogUrl,
          currentUrl,
        });
      const currentComposer = await instagramComposer(
        page,
        current,
      ).elementHandle();
      if (!currentComposer) throw stagedFailure('composer', 'unconfirmed');
      const sameComposer = await currentComposer.evaluate(
        (node, original) => node === original,
        composerNode,
      );
      if (
        (!sameComposer && !containerChanged) ||
        (phase !== 'after_send' &&
          (!(await currentComposer.isEditable()) ||
            !(await currentComposer.isEnabled()))) ||
        !(await currentNode.evaluate(
          (container, { composer, expectedBody }) => {
            // Lexical paragraphs add line breaks. Match visible text with the
            // same whitespace normalization as getByText in confirmation.
            const normalize = (text: string) =>
              text.replace(/\s+/g, ' ').trim();
            const text =
              composer instanceof HTMLTextAreaElement ||
              composer instanceof HTMLInputElement
                ? composer.value
                : (composer as HTMLElement).innerText;
            return (
              container.isConnected &&
              composer.isConnected &&
              container.contains(composer) &&
              (expectedBody === null ||
                normalize(text) === normalize(expectedBody))
            );
          },
          {
            composer: currentComposer,
            expectedBody: phase === 'after_send' ? null : body,
          },
        ))
      )
        throw stagedFailure('composer', 'mismatch');
      if (phase === 'after_fill') {
        dialog = current;
        dialogNode = currentNode;
        composerNode = currentComposer;
      }
    };
    await verifyDialog('after_fill');
    // Snapshot matching outgoing messages only in the revalidated current chat.
    const ownMessages = dialog
      .locator(outgoing.instagram)
      .filter({ has: page.getByText(body, { exact: true }) });
    const articles = await instagramArticleConfirmation(dialog, body);
    try {
      stage = 'attempt';
      await beforeSend();
      attempted = true;
      await verifyDialog('after_marker');
      stage = 'confirmation';
      const count = await ownMessages.count();
      await articles.evaluate((state) => state.arm());
      await composerNode.press('Enter');
      await Promise.any([
        ownMessages
          .nth(count)
          .waitFor({ state: 'visible', timeout: timeoutMs }),
        page.waitForFunction((state) => state.confirmed(), articles, {
          timeout: timeoutMs,
        }),
      ]).catch((error: AggregateError) => {
        throw error.errors[0];
      });
      await verifyDialog('after_send');
      stage = 'confirmation';
      return await confirmedDialogUrl(page, 'instagram');
    } finally {
      await articles.dispose();
    }
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
    if (attempted || stage === 'attempt') {
      if (
        error instanceof SocialSendError &&
        'stage' in error &&
        error.stage === 'dialog' &&
        'errorKind' in error &&
        error.errorKind === 'mismatch'
      ) {
        // Preserve safe mismatch diagnostics without making a durable attempt retryable.
        error.code = 'delivery_uncertain';
        throw error;
      }
      throw stagedFailure(stage, kind, 'delivery_uncertain');
    }
    if (error instanceof SocialSendError && 'stage' in error) throw error;
    throw stagedFailure(stage, kind);
  }
}
export async function assertSocialSession(
  page: Page,
  network: SocialNetwork,
  timeoutMs?: number,
) {
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
    throw new SocialSessionCheckError('unknown_auth');
  if (
    /captcha/i.test(url.pathname) ||
    (await page
      .locator('iframe[src*="captcha"], [data-testid="captcha"]')
      .filter({ visible: true })
      .count())
  )
    throw new SocialSessionCheckError('captcha');
  if (
    /checkpoint|challenge|security\/verification/i.test(url.pathname) ||
    (await page
      .locator(
        'form[action*="checkpoint"], [aria-label*="Confirm you"], [aria-label*="Підтвердьте"]',
      )
      .filter({ visible: true })
      .count()) ||
    (await page
      .getByText(
        /^(?:Confirm it.s you|Confirm your identity|Підтвердьте свою особу|Підтвердіть, що це ви|Подтвердите, что это вы)$/i,
      )
      .filter({ visible: true })
      .count())
  )
    throw new SocialSessionCheckError('checkpoint');
  if (
    /login|signin|authwall/i.test(url.pathname) ||
    (await page
      .locator('input[type="password"]')
      .filter({ visible: true })
      .count())
  )
    throw new SocialSessionCheckError('login_required');
  const authenticated = {
    instagram: 'a[href^="/direct/"], a[href="/accounts/edit/"]',
    facebook:
      '[aria-label="Your profile"], [aria-label="Ваш профіль"], [aria-label="Account"], a[href*="/me/"], a[href*="/messages/t/"]',
    linkedin:
      'a[href*="/messaging/"], button.global-nav__primary-link-me-menu-trigger',
  }[network];
  try {
    await page
      .locator(authenticated)
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    throw Object.assign(
      new SocialSessionCheckError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'unknown_auth'
          : socialSessionCheckReason(error, 'browser'),
      ),
      {
        errorKind:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'unconfirmed',
      },
    );
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
        browser ??= launch().catch((error) => {
          browser = undefined;
          throw new SocialSessionCheckError(
            socialSessionCheckReason(error, 'browser'),
          );
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
        } catch (error) {
          await context.close().catch(() => {});
          throw new SocialSessionCheckError(
            socialSessionCheckReason(error, 'browser'),
          );
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
    withPage,
    async check(
      account: SocialSessionAccount,
      session: SocialBrowserSession,
      timeoutMs: number,
    ) {
      try {
        return await withPage(account, session, timeoutMs, async (page) => {
          let response;
          try {
            response = await page.goto(home(account.channel), {
              waitUntil: 'domcontentloaded',
              timeout: timeoutMs,
            });
          } catch (error) {
            throw new SocialSessionCheckError(
              socialSessionCheckReason(error, 'network'),
            );
          }
          // goto returns the final main-document response, never a background resource.
          const status = response?.status();
          if (status === 429) throw new SocialSessionCheckError('rate_limit');
          if (status === 407) throw new SocialSessionCheckError('proxy');
          if (status && status >= 500)
            throw new SocialSessionCheckError('network');
          // Explicit login/challenge evidence takes precedence over ambiguous 4xx responses.
          await assertSocialSession(page, account.channel);
          if (!status || status < 200 || status >= 300)
            throw new SocialSessionCheckError('unknown_auth');
        });
      } catch (error) {
        throw new SocialSessionCheckError(
          socialSessionCheckReason(error, 'browser'),
        );
      }
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
          if (account.channel === 'facebook')
            return sendFacebook(
              page,
              target,
              timeoutMs,
              body,
              beforeSend,
              (sessionTimeoutMs) =>
                assertSocialSession(page, 'facebook', sessionTimeoutMs),
            );
          await page.goto(target.canonicalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });
          await assertSocialSession(page, account.channel);
          const messageButton = page
            .getByRole('button', { name: messageLabel })
            .first();
          if (!(await messageButton.isVisible()))
            throw new SocialSendError(
              'unavailable',
              'Сторінка LinkedIn не приймає повідомлень',
            );
          await messageButton.click();
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
