import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import {
  registerHotPage,
  unregisterHotPage,
  runOnHotPage,
  waitForFacebookRead,
} from './facebook-hot-page.js';
const fixture = () => {
  const page = new EventEmitter() as unknown as Page;
  const hot = registerHotPage('priority-fixture', page);
  return { page, hot };
};
it('releases a background DOM wait for a pending send within one polling tick', async () => {
  vi.useFakeTimers();
  const { page, hot } = fixture();
  try {
    const read = waitForFacebookRead(page, () => new Promise<never>(() => {}));
    const assertion = expect(read).rejects.toThrow('facebook_read_preempted');
    hot.pendingSends++;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(hot.events.join()).toContain('pending_send');
  } finally {
    unregisterHotPage(hot);
    vi.useRealTimers();
  }
});
it('finishes abort navigation before releasing the shared page', async () => {
  vi.useFakeTimers();
  const { page, hot } = fixture();
  let abortDone!: () => void;
  let failOld!: (reason: Error) => void;
  Object.assign(page, {
    goto: vi.fn(() => {
      failOld(Error('navigation aborted'));
      return new Promise<void>((resolve) => {
        abortDone = resolve;
      });
    }),
  });
  try {
    const read = waitForFacebookRead(
      page,
      () =>
        new Promise<never>((_, reject) => {
          failOld = reject;
        }),
      true,
    );
    let finished = false;
    const assertion = expect(read)
      .rejects.toThrow('facebook_read_preempted')
      .then(() => {
        finished = true;
      });
    hot.pendingSends++;
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    abortDone();
    await assertion;
    expect(finished).toBe(true);
  } finally {
    unregisterHotPage(hot);
    vi.useRealTimers();
  }
});
it('skips a queued read while letting the reserved send run exactly once', async () => {
  const { hot } = fixture();
  const read = vi.fn(async () => {});
  const send = vi.fn(async () => 'sent');
  try {
    hot.pendingSends++;
    const blocked = runOnHotPage(hot, read);
    const result = runOnHotPage(hot, send, 'send');
    await expect(blocked).rejects.toThrow('facebook_read_preempted');
    await expect(result).resolves.toBe('sent');
    expect(read).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(hot.activeOps).toBe(0);
  } finally {
    unregisterHotPage(hot);
  }
});
