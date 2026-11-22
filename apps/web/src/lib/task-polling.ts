export function createTaskPolling<T>({
  interval,
  load,
  active,
  onData,
  onError,
}: {
  interval: number;
  load: (signal: AbortSignal) => Promise<T>;
  active: (data: T) => boolean;
  onData: (data: T) => void;
  onError: () => void;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;
  let again = false;
  let signaled = false;
  let lastStarted = -Infinity;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => refresh(),
      Math.max(0, interval - (Date.now() - lastStarted)),
    );
  };
  const refresh = (force = false) => {
    if (stopped) return;
    if (busy) {
      if (force) again = true;
      else signaled = true;
      return;
    }
    if (!force && Date.now() - lastStarted < interval) {
      schedule();
      return;
    }
    clearTimeout(timer);
    busy = true;
    lastStarted = Date.now();
    void (async () => {
      let poll = false;
      try {
        const data = await load(controller.signal);
        if (stopped) return;
        onData(data);
        poll = active(data);
      } catch {
        if (stopped) return;
        onError();
        poll = true;
      } finally {
        busy = false;
        if (!stopped) {
          if (again) {
            again = false;
            signaled = false;
            refresh(true);
          } else if (poll || signaled) {
            signaled = false;
            schedule();
          }
        }
      }
    })();
  };
  return {
    refresh,
    stop() {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    },
  };
}
