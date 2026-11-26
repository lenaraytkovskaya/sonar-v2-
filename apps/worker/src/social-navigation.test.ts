import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { errors, type Page } from 'playwright';
import { waitForInstagramReady } from './social-send-browser.js';
import {
  navigateSocialPage,
  pollPage,
  socialNavigationDiagnostics,
} from './social-navigation.js';

it('polls until accepted and survives a replaced document', async () => {
  const read = vi
    .fn<() => Promise<{ ready: boolean }>>()
    .mockResolvedValueOnce({ ready: false })
    .mockRejectedValueOnce(new Error('Execution context was destroyed'))
    .mockResolvedValueOnce({ ready: true });
  await pollPage(read, 5000, (state) => state.ready);
  expect(read).toHaveBeenCalledTimes(3);
});

it('times out with a Playwright TimeoutError', async () => {
  await expect(pollPage(async () => false, 30)).rejects.toBeInstanceOf(
    errors.TimeoutError,
  );
});

it('rethrows other evaluation errors such as a CSP EvalError', async () => {
  const csp = new Error(
    'EvalError: Evaluating a string as JavaScript violates CSP',
  );
  await expect(pollPage(() => Promise.reject(csp), 5000)).rejects.toBe(csp);
});

it.each([true, false])(
  'recovers ERR_ABORTED only after an observed Instagram main-frame replacement (%s)',
  async (replacement) => {
    const emitter = new EventEmitter();
    const frame = { url: () => 'https://www.instagram.com/direct/inbox/' };
    const waitForEvent = vi.fn(async () => {
      throw Error('replacement not observed');
    });
    const page = Object.assign(emitter, {
      mainFrame: () => frame,
      evaluate: vi.fn(async () => true),
      waitForEvent,
      waitForFunction: vi.fn(),
      goto: vi.fn(async () => {
        if (replacement) emitter.emit('framenavigated', frame);
        throw Error('net::ERR_ABORTED');
      }),
    }) as unknown as Page;
    const result = navigateSocialPage(
      page,
      'https://www.instagram.com/direct/inbox/',
      100,
    );
    if (replacement) {
      await expect(result).resolves.toBeNull();
      expect(socialNavigationDiagnostics.get(page)?.outcome).toBe(
        'spa_interrupted',
      );
    } else await expect(result).rejects.toThrow('replacement not observed');
    expect(page.goto).toHaveBeenCalledOnce();
    expect(emitter.listenerCount('framenavigated')).toBe(0);
  },
);

it('rejects an Instagram navigation timeout after a foreign redirect despite ready-looking content', async () => {
  const timeout = Object.assign(new Error('navigation timed out'), {
    name: 'TimeoutError',
  });
  const frame = {};
  const response = {
    request: () => ({ isNavigationRequest: () => true }),
    frame: () => frame,
  };
  const emitter = new EventEmitter();
  const evaluate = vi.fn(async () => false);
  const page = Object.assign(emitter, {
    url: () => 'https://foreign.invalid/',
    mainFrame: () => frame,
    evaluate,
    goto: vi.fn(async () => {
      emitter.emit('response', response);
      throw timeout;
    }),
  }) as unknown as Page;
  await expect(
    navigateSocialPage(page, 'https://www.instagram.com/', 100),
  ).rejects.toBe(timeout);
  expect(evaluate).not.toHaveBeenCalled();
});

it('retries a destroyed Instagram execution context within the same deadline', async () => {
  const evaluate = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        'Execution context was destroyed, most likely because of a navigation',
      ),
    )
    .mockResolvedValue({ ready: true });
  const page = {
    waitForFunction: vi.fn(),
    evaluate,
    url: () => 'https://www.instagram.com/',
    locator: () => ({ filter: () => ({ count: async () => 0 }) }),
  } as unknown as Page;
  await expect(waitForInstagramReady(page, 200)).resolves.toBeUndefined();
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it.each([
  [
    new TypeError('https://private.invalid/account-id private text'),
    'TypeError',
  ],
  [new Error('strict mode violation: private account-id'), 'strict_mode'],
])(
  'does not relabel arbitrary readiness errors as splash timeouts (%s)',
  async (error, kind) => {
    const page = {
      waitForFunction: vi.fn(),
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ splash: true }),
    } as unknown as Page;
    const result = await waitForInstagramReady(page, 100).catch(
      (error) => error,
    );
    expect(result).toMatchObject({
      stage: 'initial_wait',
      startupErrorKind: kind,
    });
    expect(result.screen).toBeUndefined();
    expect(result.reasonUk).not.toMatch(/private|account-id|https:/);
  },
);

it('does not renew the Instagram readiness deadline after repeated document navigation', async () => {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    let navigatedAtDeadline = false;
    const page = {
      waitForFunction: vi.fn(),
      // Every readiness read hits a replaced document; only the final state read succeeds.
      evaluate: async () => {
        if (!navigatedAtDeadline) {
          if (Date.now() - start >= 70) navigatedAtDeadline = true;
          throw new Error('document was navigated');
        }
        return { splash: true, ready: false };
      },
      url: () => 'https://www.instagram.com/',
    } as unknown as Page;
    const result = expect(
      waitForInstagramReady(page, 70),
    ).rejects.toMatchObject({ screen: 'splash', reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(70);
    await result;
    expect(Date.now() - start).toBe(70);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a non-splash readiness timeout typed and staged', async () => {
  const page = {
    waitForFunction: vi.fn(),
    evaluate: async () => ({ splash: false, ready: false }),
  } as unknown as Page;
  await expect(waitForInstagramReady(page, 100)).rejects.toMatchObject({
    stage: 'initial_wait',
    reason: 'timeout',
    startupErrorKind: 'TimeoutError',
  });
});
