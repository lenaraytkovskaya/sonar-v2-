import type { Page } from 'playwright';
import { facebookSendNetwork } from './facebook-send-network.js';

/** A long-lived Messenger page kept open by the listener and shared with the readers. */
export interface HotPage {
  accountId: string;
  page: Page;
  // Chats the page saw change and the reader has not imported yet.
  dirty: Set<string>;
  // Last time a full (every chat) import ran through this page.
  lastFullAt: number;
  queue: Promise<unknown>;
  // Operations running or queued on the page, and sends waiting for it.
  activeOps: number;
  pendingSends: number;
  events: string[];
  // The chat the page rests on between operations: the most recently active one,
  // so its new messages arrive live instead of waiting for the next sweep.
  primary?: string;
}

/** Short timestamped line for the diagnostics; capped. */
export function noteHot(hot: HotPage, line: string) {
  hot.events.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (hot.events.length > 40) hot.events.shift();
}

const pages = new Map<string, HotPage>();

export function registerHotPage(accountId: string, page: Page): HotPage {
  facebookSendNetwork(page);
  const hot: HotPage = {
    accountId,
    page,
    dirty: new Set(),
    lastFullAt: 0,
    queue: Promise.resolve(),
    activeOps: 0,
    pendingSends: 0,
    events: [],
  };
  pages.set(accountId, hot);
  return hot;
}

export function unregisterHotPage(hot: HotPage) {
  if (pages.get(hot.accountId) === hot) pages.delete(hot.accountId);
}

export function getHotPage(accountId: string): HotPage | undefined {
  const hot = pages.get(accountId);
  return hot && !hot.page.isClosed() ? hot : undefined;
}

/** One operation at a time on the shared page, so reading and sending never interleave. */
export function runOnHotPage<T>(
  hot: HotPage,
  operation: (page: Page) => Promise<T>,
  kind: 'read' | 'send' = 'read',
): Promise<T> {
  hot.activeOps++;
  const result = hot.queue
    .catch(() => {})
    .then(() => {
      if (kind === 'read' && hot.pendingSends > 0)
        throw new Error('facebook_read_preempted');
      return operation(hot.page);
    })
    .finally(() => {
      hot.activeOps--;
    });
  hot.queue = result;
  return result;
}

/** Background waits yield without letting their continuation mutate the page. */
export async function waitForFacebookRead<T>(
  page: Page,
  wait: () => Promise<T>,
  navigation = false,
): Promise<T> {
  const hot = [...pages.values()].find((candidate) => candidate.page === page);
  if (!hot) return wait();
  const check = () => {
    if (hot.pendingSends > 0) {
      noteHot(hot, 'read yielded: pending_send');
      throw new Error('facebook_read_preempted');
    }
  };
  check();
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancellation: Promise<unknown> | undefined;
  let preempted = false;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await Promise.race([
      wait(),
      new Promise<never>((_, reject) => {
        timer = setInterval(() => {
          try {
            check();
          } catch (error) {
            if (timer) clearInterval(timer);
            if (navigation) {
              // Abort a navigation already in flight BEFORE the shared queue is
              // released; a late document must not replace the send's chat.
              preempted = true;
              cancellation = page
                .goto('about:blank', { waitUntil: 'commit', timeout: 1000 })
                .catch(() => {});
              void cancellation.finally(() => reject(error));
            } else reject(error);
          }
        }, 100);
      }),
    ]);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (timer) clearInterval(timer);
    await cancellation;
  }
  if (preempted) throw new Error('facebook_read_preempted');
  if (failed) throw failure;
  return result as T;
}
