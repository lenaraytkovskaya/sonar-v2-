import type { Page, Response } from 'playwright';

export const socialNavigationDiagnostics = new WeakMap<
  Page,
  {
    attempts: number;
    outcome: 'pending' | 'ready' | 'spa_interrupted' | 'failed';
  }
>();
const instagramUrl = (url: string) => {
  try {
    return /^(?:(www\.)?instagram\.com|ig\.me)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Executed in the page: only public UI markers, never conversation text. */
export function instagramLoadingState() {
  const visible = (node: Element) =>
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility === 'visible';
  const anyVisible = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).some(visible);
  const splashElement = anyVisible(
    '#splash-screen, #splash-screen-container, [data-testid="splash-screen"]',
  );
  const logoSelector =
    '[aria-label="Instagram logo"], img[alt="Instagram"], svg[aria-label="Instagram"]';
  const logo = anyVisible(logoSelector);
  const fromMeta =
    anyVisible('[aria-label="from Meta" i], img[alt="from Meta" i]') ||
    Array.from(document.querySelectorAll('p, span, div')).some(
      (node) =>
        node.children.length === 0 &&
        /^from\s+meta$/i.test(node.textContent?.trim() ?? '') &&
        visible(node),
    );
  const privateArea =
    '[contenteditable], input, textarea, [role="log"], [role="article"], [role="row"], [role="listitem"], [data-pagelet="IGDMessagesList"], [data-pagelet="IGDInboxThreadListScrollableAreaPagelet"]';
  const marker = (pattern: RegExp) =>
    Array.from(
      document.querySelectorAll('h1, h2, button, a, label, p, span'),
    ).some(
      (node) =>
        !node.closest(privateArea) &&
        node.children.length === 0 &&
        visible(node) &&
        pattern.test(node.textContent?.trim() ?? ''),
    );
  const login =
    anyVisible('input[name="username"], input[type="password"]') ||
    marker(/^(Log in|Увійти|Войти)$/i);
  const challenge =
    /challenge|checkpoint/i.test(location.pathname) ||
    marker(/^(Suspicious.*|Confirm it.s you)$/i);
  const nav = anyVisible('nav, [role="navigation"]');
  const main = anyVisible('main, [role="main"]');
  const dialog = anyVisible(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
  );
  const direct = anyVisible('a[href^="/direct/"]');
  const appMain = Array.from(
    document.querySelectorAll('main, [role="main"]'),
  ).some((node) => {
    if (!visible(node)) return false;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const current = walker.currentNode;
      const element =
        current instanceof Element ? current : current.parentElement;
      if (
        !element ||
        !visible(element) ||
        element.closest(
          `#splash-screen, #splash-screen-container, [data-testid="splash-screen"], ${logoSelector}`,
        )
      )
        continue;
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent?.trim() ?? '';
        if (text && !/^(Instagram|from\s+meta)$/i.test(text)) return true;
      } else if (
        element.matches(
          'input, textarea, [contenteditable], img, video, article, [role="feed"], [role="log"]',
        )
      )
        return true;
    }
    return false;
  });
  const app = nav || direct || appMain || anyVisible('[role="feed"]');
  const centralLogo = Array.from(document.querySelectorAll(logoSelector)).some(
    (node) => {
      if (!visible(node)) return false;
      const rect = node.getBoundingClientRect();
      return (
        rect.width <= 300 &&
        rect.height <= 300 &&
        Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < innerWidth * 0.2 &&
        Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < innerHeight * 0.2
      );
    },
  );
  const splash =
    !app &&
    !login &&
    !challenge &&
    (splashElement ||
      (centralLogo &&
        !dialog &&
        !marker(/^(?!(?:Instagram|from\s+meta)$).+/i)));
  const dialogHeading = Array.from(
    document.querySelectorAll(
      '[role="dialog"] :is(h1,h2,[role="heading"]), [role="alertdialog"] :is(h1,h2,[role="heading"]), [aria-modal="true"] :is(h1,h2,[role="heading"])',
    ),
  )
    .filter(visible)
    .map((node) => {
      const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return /^(Turn on Notifications|Увімкнути сповіщення|Включить уведомления)$/i.test(
        text,
      )
        ? text
        : 'other_redacted';
    })
    .slice(0, 3);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    hidden: document.hidden,
    readyState: document.readyState,
    splash,
    splashElement,
    logo,
    fromMeta,
    nav,
    main,
    dialog,
    dialogHeading,
    login,
    challenge,
    ready:
      login ||
      challenge ||
      (!splash &&
        (app ||
          anyVisible(
            'input[name="email"], iframe[src*="captcha"], [data-testid="captcha"], form[action*="checkpoint"]',
          ) ||
          /login|signin|challenge|checkpoint|captcha/i.test(
            location.pathname,
          ))),
  };
}

/** A rendered app can remain busy indefinitely. Never wait for load/network idle. */
export async function navigateSocialPage(
  page: Page,
  url: string,
  timeoutMs: number,
) {
  const diagnostic = {
    attempts: (socialNavigationDiagnostics.get(page)?.attempts ?? 0) + 1,
    outcome: 'pending' as 'pending' | 'ready' | 'spa_interrupted' | 'failed',
  };
  socialNavigationDiagnostics.set(page, diagnostic);
  let committed: Response | null = null;
  let replacement = false;
  const navigated = (frame: import('playwright').Frame) => {
    if (frame === page.mainFrame() && instagramUrl(frame.url()))
      replacement = true;
  };
  const observe = (response: Response) => {
    try {
      if (
        response.request().isNavigationRequest?.() &&
        response.frame() === page.mainFrame()
      )
        committed = response;
    } catch {
      /* Navigation may fail before Chromium attaches its frame. */
    }
  };
  const observable =
    typeof page.mainFrame === 'function' && typeof page.evaluate === 'function';
  if (observable) {
    page.on('response', observe);
    page.on('framenavigated', navigated);
  }
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    diagnostic.outcome = 'ready';
    return response;
  } catch (error) {
    diagnostic.outcome = 'failed';
    // Chromium can abort a document request when Instagram replaces it during
    // startup. Let that navigation commit; callers still verify auth/recipient.
    if (
      error instanceof Error &&
      /\bERR_ABORTED\b/.test(error.message) &&
      instagramUrl(url) &&
      typeof page.waitForFunction === 'function'
    ) {
      if (!replacement)
        await page.waitForEvent('framenavigated', {
          predicate: (frame) =>
            frame === page.mainFrame() && instagramUrl(frame.url()),
          timeout: timeoutMs,
        });
      await page.waitForFunction(
        () =>
          /^(?:(www\.)?instagram\.com|ig\.me)$/.test(location.hostname) &&
          document.readyState !== 'loading',
        undefined,
        { timeout: timeoutMs },
      );
      diagnostic.outcome = 'spa_interrupted';
      return committed;
    }
    // A stalled deferred script can outlive usable UI. Keep the actual HTTP status
    // and still run the caller's session, recipient and composer checks.
    if (!(error instanceof Error) || typeof page.evaluate !== 'function')
      throw error;
    const rendered = instagramUrl(url)
      ? [
          'https://www.instagram.com',
          'https://instagram.com',
          'https://ig.me',
        ].includes(new URL(page.url()).origin)
        ? await page
            .evaluate(instagramLoadingState)
            .then((state) => (state.splash ? 'splash' : state.ready))
            .catch(() => false)
        : false
      : await page
          .evaluate(() => {
            const visible = (selector: string) =>
              Array.from(document.querySelectorAll(selector)).some(
                (node) =>
                  node.getClientRects().length > 0 &&
                  getComputedStyle(node).visibility === 'visible',
              );
            if (/^(www\.)?facebook\.com$/.test(location.hostname))
              return (
                visible('main h1, [role="main"] h1') &&
                Array.from(
                  document.querySelectorAll(
                    'main button, main [role="button"], main a, [role="main"] [role="button"]',
                  ),
                ).some(
                  (node) =>
                    /^(Message|Send message|Повідомлення|Надіслати повідомлення|Сообщение|Отправить сообщение)$/i.test(
                      node.getAttribute('aria-label') ??
                        node.textContent?.trim() ??
                        '',
                    ) && node.getClientRects().length > 0,
                )
              );
            return false;
          })
          .catch(() => false);
    if (
      !rendered ||
      (rendered !== 'splash' && (error.name !== 'TimeoutError' || !committed))
    )
      throw error;
    diagnostic.outcome = 'spa_interrupted';
    return committed;
  } finally {
    if (observable) {
      page.off('response', observe);
      page.off('framenavigated', navigated);
    }
  }
}
