import type { Page, Response } from 'playwright';

/** A rendered app can remain busy indefinitely. Never wait for load/network idle. */
export async function navigateSocialPage(
  page: Page,
  url: string,
  timeoutMs: number,
) {
  let committed: Response | null = null;
  const observe = (response: Response) => {
    if (
      response.request().isNavigationRequest?.() &&
      response.frame() === page.mainFrame()
    )
      committed = response;
  };
  const observable =
    typeof page.mainFrame === 'function' && typeof page.evaluate === 'function';
  if (observable) page.on('response', observe);
  try {
    return await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  } catch (error) {
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
    return committed;
  } finally {
    if (observable) page.off('response', observe);
  }
}
