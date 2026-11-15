/** UI snapshots only. Never schedules provider collection or message sends. */
export function pollInbox(
  refresh: (signal: AbortSignal) => Promise<void>,
  visibility: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >,
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout>;
  let controller: AbortController;
  const run = async () => {
    clearTimeout(timer);
    if (stopped || running || visibility.visibilityState !== 'visible') return;
    running = true;
    controller = new AbortController();
    // Also bound a stalled network request so it cannot block future refreshes.
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await refresh(controller.signal);
    } catch {
      /* Retry the next snapshot. */
    } finally {
      clearTimeout(timeout);
      running = false;
      if (!stopped) timer = setTimeout(() => void run(), 20000);
    }
  };
  const changed = () => {
    if (visibility.visibilityState !== 'visible') {
      clearTimeout(timer);
      controller?.abort();
    } else void run();
  };
  visibility.addEventListener('visibilitychange', changed);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    visibility.removeEventListener('visibilitychange', changed);
  };
}
