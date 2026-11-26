import type { Page } from 'playwright';
import { waitForFacebookRead } from './facebook-hot-page.js';

export const THREAD_LINKS =
  'a[href^="/messages/t/"], a[href^="/messages/e2ee/t/"]';
const SCAN_MS = 2000;
// Reload the long-lived page so a stale websocket cannot silence the listener.
const RELOAD_MS = 30 * 60 * 1000;

export interface MessengerThread {
  href: string;
  text: string;
  unread?: boolean;
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

// Raw provider IDs never leave this page-local memory or enter diagnostics.
const priorities = new WeakMap<
  Page,
  Map<string, { observed: Set<string>; pending: Set<string> }>
>();
const priorityPath = (path: string) => path.replace(/\/$/, '');
export function facebookMessagePriority(page: Page, path: string) {
  return [...(priorities.get(page)?.get(priorityPath(path))?.pending ?? [])];
}
export function pendingFacebookThreads(page: Page) {
  return [...(priorities.get(page) ?? [])]
    .filter(([, state]) => state.pending.size > 0)
    .map(([path]) => path);
}
export function consumeFacebookMessagePriority(
  page: Page,
  messages: { externalMessageId: string; threadUrl?: string }[],
) {
  for (const message of messages)
    if (message.threadUrl)
      priorities
        .get(page)
        ?.get(priorityPath(new URL(message.threadUrl).pathname))
        ?.pending.delete(message.externalMessageId);
}

/** Messenger-only activity; Facebook title counters also include notifications. */
export async function readMessengerSnapshot(
  page: Page,
): Promise<MessengerSnapshot> {
  const { messageIds, ...snapshot } = await page.evaluate((links) => {
    const visible = (node: Element) =>
      !!node.getClientRects().length &&
      getComputedStyle(node).visibility !== 'hidden' &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]');
    const unreadLabel = /непрочитан|\bunread\b/i;
    const overlay =
      '[role="dialog"], [role="menu"], [role="log"], [role="article"]';
    const messenger = Array.from(
      document.querySelectorAll(
        'button[aria-label], [role="button"][aria-label], a[aria-label]',
      ),
    ).filter(
      (node) =>
        !node.closest(overlay) &&
        /^Messenger(?:\b|,)/i.test(node.getAttribute('aria-label') ?? '') &&
        visible(node),
    );
    // Never inspect a shared toolbar parent: it also contains Notifications.
    const badge =
      messenger.length === 1
        ? Math.max(
            0,
            ...[
              messenger[0]!,
              ...Array.from(
                messenger[0]!.querySelectorAll('[aria-label], span'),
              ),
            ]
              .filter(visible)
              .map((node) => {
                const label = node.getAttribute('aria-label') ?? '';
                const value = unreadLabel.test(label)
                  ? /\d+/.exec(label)?.[0]
                  : /^\d+\+?$/.exec(node.textContent?.trim() ?? '')?.[0];
                return Number.parseInt(value ?? '0', 10);
              }),
          )
        : 0;
    const threads = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(links),
    )
      .filter(
        (link) =>
          visible(link) &&
          !link.closest(overlay) &&
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
        unread:
          unreadLabel.test(
            [
              link.getAttribute('aria-label') ?? '',
              ...Array.from(link.querySelectorAll('[aria-label]'))
                .filter(visible)
                .map((node) => node.getAttribute('aria-label') ?? ''),
            ].join(' '),
          ) ||
          Array.from(link.querySelectorAll('span[dir="auto"]'))
            .slice(1, 2)
            .some(
              (node) =>
                Number.parseInt(getComputedStyle(node).fontWeight, 10) >= 700,
            ),
      }));
    const rows = threads.map((thread) => `${thread.href}#${thread.text}`);
    const blocked =
      /\/(checkpoint|login|recover)/.test(location.pathname) ||
      !!document.querySelector(
        'input[autocomplete="one-time-code"], input[aria-label="PIN"]',
      );
    const logs = Array.from(document.querySelectorAll('[role="log"]')).filter(
      (node) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== 'hidden' &&
        !node.closest('[hidden],[aria-hidden="true"],[inert],[role="dialog"]'),
    );
    const log = logs.length === 1 ? logs[0]! : null;
    const ids = log
      ? Array.from(log.querySelectorAll('[data-message-id]')).filter((node) => {
          const id = node.getAttribute('data-message-id') ?? '';
          return (
            visible(node) &&
            id.length > 0 &&
            id.length <= 1000 &&
            !/[\p{Cc}]/u.test(id)
          );
        })
      : [];
    // The peer's "seen" avatar sits at the right edge under our own message.
    let seenId = '';
    if (log) {
      const box = log.getBoundingClientRect();
      for (const row of ids)
        for (const img of Array.from(row.querySelectorAll('img'))) {
          const at = img.getBoundingClientRect();
          if (at.width && at.left + at.width / 2 > box.left + box.width * 0.6)
            seenId = row.getAttribute('data-message-id') ?? '';
        }
    }
    const fingerprint = (value: string) => {
      if (!value) return '';
      let hash = 2166136261;
      for (const char of value)
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return (hash >>> 0).toString(16);
    };
    const open = {
      href: location.pathname,
      last: `${fingerprint([...new Set(ids.map((node) => node.getAttribute('data-message-id') ?? ''))].sort().join(','))}|${fingerprint(seenId)}`,
    };
    const dialog = document.querySelector('[role="dialog"]');
    return {
      messageIds: ids.map((node) => node.getAttribute('data-message-id')!),
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
      unread: Math.max(badge, threads.filter((thread) => thread.unread).length),
      signature: rows.join('\n'),
      blocked,
      threads,
    };
  }, THREAD_LINKS);
  const path = priorityPath(snapshot.open.href);
  if (/^\/messages\/(?:e2ee\/)?t\/\d+$/.test(path)) {
    const states = priorities.get(page) ?? new Map();
    priorities.set(page, states);
    const state = states.get(path);
    const observed = new Set(messageIds);
    const pending: Set<string> = state?.pending ?? new Set();
    if (state) {
      if (observed.size)
        for (const id of pending) if (!observed.has(id)) pending.delete(id);
      for (const id of observed)
        if (/^\d+@msgr\.\d+$/.test(id) && !state.observed.has(id))
          pending.add(id);
    }
    states.set(path, { observed, pending });
  }
  return snapshot;
}

// A new message in the chat that stays open moves neither the list preview nor
// the Messenger badge, so the newest message id of the open chat is watched too.
function openChatMoved(previous: MessengerSnapshot, next: MessengerSnapshot) {
  return (
    !!previous.open &&
    !!next.open &&
    previous.open.href === next.open.href &&
    previous.open.last.split('|')[0] !== '' &&
    next.open.last.split('|')[0] !== '' &&
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
    (next.threads ?? []).some(
      (thread) =>
        thread.unread &&
        !(previous.threads ?? []).find((old) => old.href === thread.href)
          ?.unread,
    ) ||
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
    (previous.threads ?? []).map((thread) => [thread.href, thread]),
  );
  const changed = (next.threads ?? [])
    .filter((thread) => {
      const old = before.get(thread.href);
      return !old || old.text !== thread.text || (!old.unread && thread.unread);
    })
    .map((thread) => thread.href);
  if (openChatMoved(previous, next) && next.open) changed.push(next.open.href);
  if (changed.length) return changed;
  return next.unread > previous.unread
    ? (next.threads ?? []).slice(0, fallback).map((thread) => thread.href)
    : [];
}

/** Close only an explicitly expanded Notifications toggle, never a generic dialog. */
export async function closeFacebookNotifications(page: Page) {
  const toggle = page
    .locator('header, [role="banner"], nav, [role="navigation"]')
    .getByRole('button', {
      name: /^(?:Сповіщення|Notifications|Уведомления)(?:$|[, :])/i,
    })
    .filter({ visible: true })
    .and(
      page.locator(
        ':not(main *, [role="main"] *, [role="log"] *, [role="dialog"] *)',
      ),
    );
  const expanded = toggle.and(page.locator('[aria-expanded="true"]'));
  if ((await toggle.count()) !== 1 || (await expanded.count()) !== 1)
    return false;
  return expanded.click({ timeout: 1000 }).then(
    () => true,
    () => false,
  );
}

function messengerSignal(
  previous: MessengerSnapshot,
  snapshot: MessengerSnapshot,
) {
  return JSON.stringify([
    snapshot.unread,
    [...(snapshot.threads ?? [])].sort((a, b) => a.href.localeCompare(b.href)),
    openChatMoved(previous, snapshot) ? snapshot.open : null,
  ]);
}

/** Retained across reloads: identical badge/read-mark oscillations are not fresh mail. */
export class MessengerSignalCooldown {
  private readonly wakes = new Map<string, number>();

  accept(
    previous: MessengerSnapshot,
    snapshot: MessengerSnapshot,
    now: number,
    cooldownMs: number,
  ) {
    const key = messengerSignal(previous, snapshot);
    const last = this.wakes.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.wakes.delete(key);
    this.wakes.set(key, now);
    if (this.wakes.size > 100)
      this.wakes.delete(this.wakes.keys().next().value!);
    return true;
  }
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
    signalCooldownMs?: number;
    signalCooldown?: MessengerSignalCooldown;
    scanMs?: number;
    reloadMs?: number;
    onScan?: (snapshot: MessengerSnapshot) => void;
    onEvent?: (line: string) => void;
    // Consecutive scans without a single chat link before the page is reloaded.
    emptyReloadScans?: number;
    // While true the page is being driven by an importer or a send: its own
    // navigation and read marks are not news, so the baseline just follows.
    paused?: () => boolean;
  },
): Promise<WatchEnd> {
  const started = Date.now();
  const signals = options.signalCooldown ?? new MessengerSignalCooldown();
  let previous = await firstSnapshot(page);
  let lastWake = 0;
  const pending = new Map<
    string,
    { previous: MessengerSnapshot; next: MessengerSnapshot }
  >();
  let emptyScans = 0;
  while (!options.stopped()) {
    if (
      !options.paused?.() &&
      Date.now() - started >= (options.reloadMs ?? RELOAD_MS)
    )
      return 'reload';
    await new Promise((resolve) =>
      setTimeout(resolve, options.scanMs ?? SCAN_MS),
    );
    let next: MessengerSnapshot;
    try {
      if (!options.paused?.()) await closeFacebookNotifications(page);
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
    if (options.paused?.()) {
      previous = next;
      continue;
    }
    options.onScan?.(next);
    if (next.open && previous.open && next.open.last !== previous.open.last)
      options.onEvent?.('open_message_changed');
    if (next.unread !== previous.unread)
      options.onEvent?.(`unread ${previous.unread}>${next.unread}`);
    if (next.blocked) return 'blocked';
    // A dead page (network error, stuck load) shows no chats at all: reload it.
    emptyScans = (next.threads?.length ?? 0) === 0 ? emptyScans + 1 : 0;
    if (emptyScans >= (options.emptyReloadScans ?? 15)) {
      options.onEvent?.('empty page, reloading');
      return 'reload';
    }
    if (messengerChanged(previous, next))
      pending.set(messengerSignal(previous, next), { previous, next });
    previous = next;
    if (pending.size && Date.now() - lastWake >= options.minGapMs) {
      const now = Date.now();
      const changed = new Set<string>();
      let wake = false;
      for (const signal of pending.values()) {
        if (
          signals.accept(
            signal.previous,
            signal.next,
            now,
            options.signalCooldownMs ?? 0,
          )
        ) {
          wake = true;
          for (const href of changedThreads(signal.previous, signal.next))
            changed.add(href);
        } else options.onEvent?.('same signal, cooldown');
      }
      pending.clear();
      if (wake) {
        lastWake = now;
        await options.onChange([...changed]);
      }
    }
  }
  return 'stopped';
}

const THREAD_HREF = /^\/messages\/(?:e2ee\/)?t\/\d+\/?$/;

/**
 * Encrypted chats do not refresh their list preview or the Messenger badge live,
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
  shouldStop: () => boolean = () => false,
): Promise<string[]> {
  const changed: string[] = [];
  const deadline = Date.now() + budgetMs;
  for (const href of hrefs) {
    if (shouldStop()) break;
    if (!THREAD_HREF.test(href) || Date.now() >= deadline) continue;
    const path = href.replace(/\/$/, '');
    const left = () => Math.max(1, deadline - Date.now());
    const lastId = async () => (await readMessengerSnapshot(page)).open;
    const startedAt = Date.now();
    try {
      // An encrypted chat only shows what arrived since it was last loaded when
      // the page is loaded afresh; opening it by a click inside the page keeps
      // the old content. Other chats update in place, so a click is enough.
      if (/\/e2ee\//.test(path)) {
        await waitForFacebookRead(
          page,
          () =>
            page.goto(`https://www.facebook.com${path}/`, {
              waitUntil: 'domcontentloaded',
              timeout: left(),
            }),
          true,
        );
      } else if (new URL(page.url()).pathname.replace(/\/$/, '') !== path) {
        const link = page.locator(`a[href="${href}"]`).first();
        if (!(await link.count())) continue;
        await link.click({ timeout: Math.min(250, left()), noWaitAfter: true });
        await waitForFacebookRead(page, () =>
          page.waitForURL((url) => url.pathname.replace(/\/$/, '') === path, {
            timeout: left(),
          }),
        );
      }
      await waitForFacebookRead(page, () =>
        page.waitForFunction(
          () =>
            Array.from(
              document.querySelectorAll('[role="log"] [data-message-id]'),
            ).some(
              (node) =>
                node.getClientRects().length > 0 &&
                !node.closest(
                  '[hidden],[aria-hidden="true"],[inert],[role="dialog"]',
                ),
            ),
          undefined,
          { timeout: left() },
        ),
      );
      const snapshot = await lastId();
      if (
        !snapshot ||
        snapshot.href.replace(/\/$/, '') !== path ||
        !snapshot.last.split('|')[0]
      )
        continue;
      const id = snapshot.last;
      const previous = seen.get(path);
      seen.set(path, id);
      log(
        `sweep changed=${previous !== id} elapsedMs=${Date.now() - startedAt}`,
      );
      if (previous !== id) changed.push(href);
    } catch {
      // A chat that does not open in time is simply tried again next sweep.
      log(`sweep failed elapsedMs=${Date.now() - startedAt}`);
    }
  }
  return changed;
}

/** Brings the page back to a chat by a click inside it; failures are ignored. */
export async function focusThread(page: Page, href: string, budgetMs: number) {
  const path = href.replace(/\/$/, '');
  if (!THREAD_HREF.test(href)) return;
  try {
    if (new URL(page.url()).pathname.replace(/\/$/, '') === path) return;
    const link = page.locator(`a[href="${href}"]`).first();
    if (!(await link.count())) return;
    await waitForFacebookRead(page, async () => {});
    await link.click({ timeout: Math.min(250, budgetMs), noWaitAfter: true });
    await waitForFacebookRead(page, () =>
      page.waitForURL((url) => url.pathname.replace(/\/$/, '') === path, {
        timeout: budgetMs,
      }),
    );
  } catch {
    // The next sweep or send opens it again.
  }
}
