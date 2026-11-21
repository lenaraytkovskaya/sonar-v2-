import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { probeNetwork } from './network-probe.js';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')('network probe', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it('records the load time of reachable targets and the failure of the others', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'ok.test')
        return route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' });
      if (url.hostname === 'slow.test') return new Promise(() => {});
      return route.abort();
    });
    const result = await probeNetwork(
      context,
      {
        ok: 'https://ok.test/',
        slow: 'https://slow.test/',
        down: 'https://down.test/',
      },
      400,
    );
    expect(typeof result.ok).toBe('number');
    expect(result.slow).toBe('timeout');
    expect(String(result.down)).toMatch(/^error /);
    expect(context.pages()).toHaveLength(0);
    await context.close();
  });
});
