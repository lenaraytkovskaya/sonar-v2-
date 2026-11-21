import type { Page } from 'playwright';

export const THREAD_LINKS =
  'a[href^="/messages/t/"], a[href^="/messages/e2ee/t/"]';
const SCAN_MS = 2000;
// Reload the long-lived page so a stale websocket cannot silence the listener.
const RELOAD_MS = 30 * 60 * 1000;

export interface MessengerThread {
  href: string;
  text: string;
}
export interface MessengerSnapshot {
  unread: number;
  signature: string;
  blocked: boolean;
  threads?: MessengerThread[];
}

/** Language-independent view of the Messenger page: title counter, thread order and previews. */
export function readMessengerSnapshot(page: Page): Promise<MessengerSnapshot> {
  return page.evaluate((links) => {
    const counter = /^\((\d+)\)/.exec(document.title);
    const threads = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(links),
    )
      .slice(0, 15)
      .map((link) => ({
        href: link.getAttribute('href') ?? '',
        text: Array.from(link.querySelectorAll('span[dir="auto"]'))
          .slice(0, 2)
          .map((node) => node.textContent ?? '')
          .join('|'),
      }));
    const rows = threads.map((thread) => `${thread.href}#${thread.text}`);
    const blocked =
      /\/(checkpoint|login|recover)/.test(location.pathname) ||
      !!document.querySelector(
        'input[autocomplete="one-time-code"], input[aria-label="PIN"]',
      );
    return {
      unread: counter ? Number(counter[1]) : 0,
      signature: rows.join('\n'),
      blocked,
      threads,
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

// Chats whose preview moved or that appeared since the previous scan. A bare
// unread-counter rise names no chat, so the top of the list stands in for it.
export function changedThreads(
  previous: MessengerSnapshot,
  next: MessengerSnapshot,
  fallback = 3,
) {
  const before = new Map(
    (previous.threads ?? []).map((thread) => [thread.href, thread.text]),
  );
  const changed = (next.threads ?? [])
    .filter((thread) => before.get(thread.href) !== thread.text)
    .map((thread) => thread.href);
  if (changed.length) return changed;
  return next.unread > previous.unread
    ? (next.threads ?? []).slice(0, fallback).map((thread) => thread.href)
    : [];
}

export type WatchEnd = 'blocked' | 'reload' | 'stopped';

/** Poll a loaded Messenger page and call onChange on every new activity, at most once per minGapMs. */
export async function watchMessenger(
  page: Page,
  options: {
    onChange: (changed: string[]) => Promise<void>;
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
  const pending = new Set<string>();
  while (!options.stopped()) {
    if (Date.now() - started >= (options.reloadMs ?? RELOAD_MS))
      return 'reload';
    await new Promise((resolve) =>
      setTimeout(resolve, options.scanMs ?? SCAN_MS),
    );
    const next = await readMessengerSnapshot(page);
    if (next.blocked) return 'blocked';
    if (messengerChanged(previous, next)) {
      dirty = true;
      for (const href of changedThreads(previous, next)) pending.add(href);
    }
    previous = next;
    if (dirty && Date.now() - lastWake >= options.minGapMs) {
      dirty = false;
      lastWake = Date.now();
      const changed = [...pending];
      pending.clear();
      await options.onChange(changed);
    }
  }
  return 'stopped';
}
