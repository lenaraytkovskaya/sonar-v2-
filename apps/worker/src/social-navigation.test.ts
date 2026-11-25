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
