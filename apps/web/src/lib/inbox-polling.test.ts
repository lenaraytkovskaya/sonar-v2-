import { afterEach, expect, it, vi } from 'vitest';
import { pollInbox } from './inbox-polling';
import { isNearBottom, newMessageCount } from './inbox-scroll';

function visibility() {
  const target = new EventTarget();
  return Object.assign(target, { visibilityState: 'visible' });
}
afterEach(() => vi.useRealTimers());

it('serializes slow requests, aborts on cleanup and discards timers', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let signal!: AbortSignal;
  const refresh = vi.fn((next: AbortSignal) => {
    signal = next;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const stop = pollInbox(refresh, visibility() as Document);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(true);
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('pauses hidden tabs, refreshes on return and retries failed reads without replaying actions', async () => {
  vi.useFakeTimers();
  const page = visibility();
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValue(undefined);
  const stop = pollInbox(refresh, page as Document);
  await vi.advanceTimersByTimeAsync(20000);
  expect(refresh).toHaveBeenCalledTimes(2);
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(2);
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(3);
  stop();
  page.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes reading history from following latest; repeated snapshots/status edits do not count', () => {
  expect(
    isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }),
  ).toBe(true);
  expect(
    isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 400 }),
  ).toBe(false);
  expect(newMessageCount(['a', 'b'], ['a', 'b'])).toBe(0);
  expect(newMessageCount(['a', 'b'], ['a', 'b', 'c'])).toBe(1);
});
