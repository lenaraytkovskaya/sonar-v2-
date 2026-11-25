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
    const rendered = await page
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
        if (/^(?:(www\.)?instagram\.com|ig\.me)$/.test(location.hostname))
          return visible(
            '#splash-screen, #splash-screen-container, [data-testid="splash-screen"], [aria-label="Instagram logo"]',
          )
            ? 'splash'
            : false;
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
