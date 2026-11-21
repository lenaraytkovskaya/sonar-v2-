import type { Page } from 'playwright';

export const THREAD_LINKS =
  'a[href^="/messages/t/"], a[href^="/messages/e2ee/t/"]';
const SCAN_MS = 2000;
// Reload the long-lived page so a stale websocket cannot silence the listener.
const RELOAD_MS = 30 * 60 * 1000;

export interface MessengerSnapshot {
  unread: number;
  signature: string;
  blocked: boolean;
}

/** Language-independent view of the Messenger page: title counter, thread order and previews. */
export function readMessengerSnapshot(page: Page): Promise<MessengerSnapshot> {
  return page.evaluate((links) => {
    const counter = /^\((\d+)\)/.exec(document.title);
    const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>(links))
      .slice(0, 15)
      .map((link) => {
        const texts = Array.from(link.querySelectorAll('span[dir="auto"]'))
          .slice(0, 2)
          .map((node) => node.textContent ?? '')
          .join('|');
        return `${link.getAttribute('href')}#${texts}`;
      });
    const blocked =
      /\/(checkpoint|login|recover)/.test(location.pathname) ||
      !!document.querySelector(
        'input[autocomplete="one-time-code"], input[aria-label="PIN"]',
      );
    return {
      unread: counter ? Number(counter[1]) : 0,
      signature: rows.join('\n'),
      blocked,
    };
  }, THREAD_LINKS);
}

export function messengerChanged(
  previous: MessengerSnapshot,
  next: MessengerSnapshot,
) {
  return (
    next.unread > previous.unread ||
    (next.signature !== '' && next.signature !== previous.signature)
  );
}

export type WatchEnd = 'blocked' | 'reload' | 'stopped';

/** Poll a loaded Messenger page and call onChange on every new activity, at most once per minGapMs. */
export async function watchMessenger(
  page: Page,
  options: {
    onChange: () => Promise<void>;
    stopped: () => boolean;
    minGapMs: number;
    scanMs?: number;
    reloadMs?: number;
  },
): Promise<WatchEnd> {
  const started = Date.now();
  let previous = await readMessengerSnapshot(page);
  let lastWake = 0;
  let dirty = false;
  while (!options.stopped()) {
    if (Date.now() - started >= (options.reloadMs ?? RELOAD_MS))
      return 'reload';
    await new Promise((resolve) =>
      setTimeout(resolve, options.scanMs ?? SCAN_MS),
    );
    const next = await readMessengerSnapshot(page);
    if (next.blocked) return 'blocked';
    if (messengerChanged(previous, next)) dirty = true;
    previous = next;
    if (dirty && Date.now() - lastWake >= options.minGapMs) {
      dirty = false;
      lastWake = Date.now();
      await options.onChange();
    }
  }
  return 'stopped';
}
