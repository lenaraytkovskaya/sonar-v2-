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
  // The chat currently open in the page and its newest message id.
  open?: { href: string; last: string };
  // Diagnostics only: what the page shows besides the chat list.
  page?: {
    path: string;
    hidden: boolean;
    dialog: string;
    notes: string[];
  };
}

/** Language-independent view of the Messenger page: title counter, thread order and previews. */
export function readMessengerSnapshot(page: Page): Promise<MessengerSnapshot> {
  return page.evaluate((links) => {
    const counter = /^\((\d+)\)/.exec(document.title);
    const threads = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(links),
    )
      .filter((link) =>
        /^\/messages\/(?:e2ee\/)?t\/\d+\/?$/.test(
          link.getAttribute('href') ?? '',
        ),
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
    const log = document.querySelector('[role="log"]');
    const ids = log
      ? Array.from(log.querySelectorAll('[data-message-id]'))
      : [];
    const open = {
      href: location.pathname,
      last: ids.length
        ? (ids[ids.length - 1]!.getAttribute('data-message-id') ?? '')
        : '',
    };
    const dialog = document.querySelector('[role="dialog"]');
    return {
      open,
      page: {
        path: location.pathname,
        hidden: document.hidden,
        dialog: (dialog?.textContent ?? '').slice(0, 60),
        // Banners and alerts, e.g. a notice that Messenger is active elsewhere.
        notes: Array.from(
          document.querySelectorAll(
            '[role="alert"], [role="status"], [role="banner"]',
          ),
        )
          .map((node) => (node.textContent ?? '').trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 4),
      },
      unread: counter ? Number(counter[1]) : 0,
      signature: rows.join('\n'),
      blocked,
      threads,
    };
  }, THREAD_LINKS);
}

// A new message in the chat that stays open moves neither the list preview nor
// the title counter, so the newest message id of the open chat is watched too.
function openChatMoved(previous: MessengerSnapshot, next: MessengerSnapshot) {
  return (
    !!previous.open &&
    !!next.open &&
    previous.open.href === next.open.href &&
    next.open.last !== '' &&
    next.open.last !== previous.open.last
  );
}

export function messengerChanged(
  previous: MessengerSnapshot,
  next: MessengerSnapshot,
) {
  return (
    openChatMoved(previous, next) ||
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
  if (openChatMoved(previous, next) && next.open) changed.push(next.open.href);
  if (changed.length) return changed;
  return next.unread > previous.unread
    ? (next.threads ?? []).slice(0, fallback).map((thread) => thread.href)
    : [];
}

async function firstSnapshot(page: Page) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readMessengerSnapshot(page);
    } catch (error) {
      if (
        attempt < 20 &&
        error instanceof Error &&
        /context was destroyed|navigat/i.test(error.message)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      throw error;
    }
  }
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
    onScan?: (snapshot: MessengerSnapshot) => void;
    onEvent?: (line: string) => void;
  },
): Promise<WatchEnd> {
  const started = Date.now();
  let previous = await firstSnapshot(page);
  let lastWake = 0;
  let dirty = false;
  const pending = new Set<string>();
  while (!options.stopped()) {
    if (Date.now() - started >= (options.reloadMs ?? RELOAD_MS))
      return 'reload';
    await new Promise((resolve) =>
      setTimeout(resolve, options.scanMs ?? SCAN_MS),
    );
    let next: MessengerSnapshot;
    try {
      next = await readMessengerSnapshot(page);
    } catch (error) {
      // A navigation by the importer or a reload destroys the page context for
      // a moment; that is not a reason to drop the listener.
      if (
        error instanceof Error &&
        /context was destroyed|navigat/i.test(error.message)
      )
        continue;
      throw error;
    }
    options.onScan?.(next);
    if (next.open && previous.open && next.open.last !== previous.open.last)
      options.onEvent?.(
        `open ${next.open.href.slice(-6)} ${previous.open.last.slice(-6)}>${next.open.last.slice(-6)}`,
      );
    if (next.unread !== previous.unread)
      options.onEvent?.(`unread ${previous.unread}>${next.unread}`);
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

const THREAD_HREF = /^\/messages\/(?:e2ee\/)?t\/\d+\/?$/;

/**
 * Encrypted chats do not refresh their list preview or the title counter live,
 * only the open chat updates. A sweep therefore opens the top chats of the list
 * one by one (inside the shared page) and compares the newest message id of each
 * with the previous sweep. Returns the chats that changed since then.
 */
export async function sweepThreads(
  page: Page,
  hrefs: string[],
  seen: Map<string, string>,
  budgetMs: number,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  const changed: string[] = [];
  const deadline = Date.now() + budgetMs;
  for (const href of hrefs) {
    if (!THREAD_HREF.test(href) || Date.now() >= deadline) continue;
    const path = href.replace(/\/$/, '');
    const left = () => Math.max(1, deadline - Date.now());
    const lastId = () =>
      page.evaluate(() => {
        const log = document.querySelector('[role="log"]');
        const ids = log
          ? Array.from(log.querySelectorAll('[data-message-id]'))
          : [];
        return ids.length
          ? (ids[ids.length - 1]!.getAttribute('data-message-id') ?? '')
          : '';
      });
    try {
      if (new URL(page.url()).pathname.replace(/\/$/, '') !== path) {
        const link = page.locator(`a[href="${href}"]`).first();
        if (!(await link.count())) continue;
        await link.click({ timeout: left() });
        await page.waitForURL(
          (url) => url.pathname.replace(/\/$/, '') === path,
          { timeout: left() },
        );
      }
      await page.waitForFunction(
        () => !!document.querySelector('[role="log"] [data-message-id]'),
        undefined,
        { timeout: left() },
      );
      const id = await lastId();
      if (!id) continue;
      const previous = seen.get(path);
      seen.set(path, id);
      log(
        `sweep ${path.slice(-6)} last=${id.slice(-6)} prev=${(previous ?? '-').slice(-6)}`,
      );
      if (previous !== undefined && previous !== id) changed.push(href);
    } catch (error) {
      // A chat that does not open in time is simply tried again next sweep.
      log(
        `sweep ${path.slice(-6)} failed ${error instanceof Error ? error.name : '?'}`,
      );
    }
  }
  return changed;
}
