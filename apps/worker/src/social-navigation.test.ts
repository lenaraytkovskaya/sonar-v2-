import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { errors, type Page } from 'playwright';
import { waitForInstagramReady } from './social-send-browser.js';
import {
  navigateSocialPage,
  socialNavigationDiagnostics,
} from './social-navigation.js';

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
      evaluate: vi.fn(),
      waitForEvent,
      waitForFunction: vi.fn(async () => {}),
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
  const waitForFunction = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        'Execution context was destroyed, most likely because of a navigation',
      ),
    )
    .mockResolvedValue(undefined);
  const page = {
    waitForFunction,
    url: () => 'https://www.instagram.com/',
    locator: () => ({ filter: () => ({ count: async () => 0 }) }),
  } as unknown as Page;
  await expect(waitForInstagramReady(page, 200)).resolves.toBeUndefined();
  expect(waitForFunction).toHaveBeenCalledTimes(2);
  expect(waitForFunction.mock.calls[1]![2].timeout).toBeLessThan(
    waitForFunction.mock.calls[0]![2].timeout,
  );
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
      waitForFunction: vi.fn().mockRejectedValue(error),
      evaluate: async () => ({ splash: true }),
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
    const page = {
      waitForFunction: vi
        .fn()
        .mockRejectedValue(new Error('document was navigated')),
      evaluate: async () => ({ splash: true }),
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
    waitForFunction: vi
      .fn()
      .mockRejectedValue(new errors.TimeoutError('private url')),
    evaluate: async () => ({ splash: false }),
  } as unknown as Page;
  await expect(waitForInstagramReady(page, 100)).rejects.toMatchObject({
    stage: 'initial_wait',
    reason: 'timeout',
    startupErrorKind: 'TimeoutError',
  });
});
