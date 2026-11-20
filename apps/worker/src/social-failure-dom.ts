import type { Page } from 'playwright';
import { failureDomSkeleton } from '@sonar/core/social-failure-dom';

export { failureDomSkeleton } from '@sonar/core/social-failure-dom';
export async function captureFailureDom(
  page: Page,
  metadata: { phase?: string; elapsedMs?: number } = {},
) {
  if (
    page.url() !== 'about:blank' &&
    !/^(?:(?:www\.)?(?:facebook|instagram)\.com|ig\.me)$/.test(
      new URL(page.url()).hostname,
    )
  )
    return;
  const dom = {
    ...(await page.evaluate(failureDomSkeleton, 200 * 1024 - 512)),
    phase:
      metadata.phase && /^[a-z_]{1,40}$/.test(metadata.phase)
        ? metadata.phase
        : 'unknown',
    elapsedMs:
      Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs! >= 0
        ? Math.round(metadata.elapsedMs!)
        : 0,
  };
  return Buffer.byteLength(JSON.stringify(dom), 'utf8') <= 200 * 1024
    ? dom
    : undefined;
}
