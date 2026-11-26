import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
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
