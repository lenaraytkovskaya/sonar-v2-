import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTaskPolling } from './task-polling';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(
  load = vi
    .fn<(signal: AbortSignal) => Promise<boolean>>()
    .mockResolvedValue(false),
) {
  const onData = vi.fn(),
    onError = vi.fn();
  const runner = createTaskPolling({
    interval: 7500,
    load,
    active: (value) => value,
    onData,
    onError,
  });
  return { ...runner, load, onData, onError };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
});
it('polls active work at the configured interval, then rests when idle', async () => {
  const runner = setup(
    vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
  );
  runner.refresh(true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(7499);
  expect(runner.load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(runner.load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30000);
  expect(runner.load).toHaveBeenCalledTimes(2);
  runner.stop();
});
it('coalesces force refreshes during a request without overlap', async () => {
  const request = deferred<boolean>();
  const runner = setup(
    vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(false),
  );
  runner.refresh(true);
  runner.refresh(true);
  runner.refresh(true);
  await vi.advanceTimersByTimeAsync(20000);
  expect(runner.load).toHaveBeenCalledTimes(1);
  request.resolve(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(runner.load).toHaveBeenCalledTimes(2);
  runner.stop();
});
it('uses background signals to discover idle work while throttling global changes', async () => {
  const runner = setup(
    vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
  );
  runner.refresh(true);
  await vi.advanceTimersByTimeAsync(3000);
  runner.refresh();
  await vi.advanceTimersByTimeAsync(3000);
  runner.refresh();
  expect(runner.load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(runner.load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(7500);
  expect(runner.load).toHaveBeenCalledTimes(3);
  runner.stop();
});
it('reports failure without replacing existing data and retries naturally', async () => {
  const runner = setup(
    vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(Error())
      .mockResolvedValue(false),
  );
  runner.refresh(true);
  await vi.advanceTimersByTimeAsync(7500);
  expect(runner.onError).toHaveBeenCalledTimes(1);
  expect(runner.onData.mock.calls).toEqual([[true]]);
  await vi.advanceTimersByTimeAsync(7500);
  expect(runner.onData.mock.calls).toEqual([[true], [false]]);
  runner.stop();
});
it('aborts on selection change and ignores stale completion while a new instance loads', async () => {
  const request = deferred<boolean>();
  const old = setup(vi.fn().mockReturnValue(request.promise));
  old.refresh(true);
  const signal = old.load.mock.calls[0]![0] as AbortSignal;
  old.stop();
  expect(signal.aborted).toBe(true);
  const next = setup();
  next.refresh(true);
  request.resolve(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(old.onData).not.toHaveBeenCalled();
  expect(old.onError).not.toHaveBeenCalled();
  expect(next.onData.mock.calls).toEqual([[false]]);
  expect(old.load).toHaveBeenCalledTimes(1);
  next.stop();
});
