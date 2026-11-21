import type { BrowserContext } from 'playwright';

export const PROBE_TARGETS: Record<string, string> = {
  // Neutral sites tell a slow proxy from a slowdown aimed at Meta.
  example: 'https://example.com/',
  wikipedia: 'https://www.wikipedia.org/',
  facebook: 'https://www.facebook.com/robots.txt',
  instagram: 'https://www.instagram.com/robots.txt',
};

export type ProbeResult = Record<string, number | string>;

/**
 * Loads each target in a short-lived tab of the profile browser (so it uses the
 * same proxy as the real work) and records how long the load took.
 */
export async function probeNetwork(
  context: BrowserContext,
  targets: Record<string, string> = PROBE_TARGETS,
  timeoutMs = 20000,
): Promise<ProbeResult> {
  const result: ProbeResult = {};
  for (const [name, url] of Object.entries(targets)) {
    const page = await context.newPage();
    const started = Date.now();
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      result[name] = Date.now() - started;
    } catch (error) {
      result[name] =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : `error ${error instanceof Error ? error.message.slice(0, 40) : '?'}`;
    } finally {
      await page.close().catch(() => {});
    }
  }
  return result;
}
