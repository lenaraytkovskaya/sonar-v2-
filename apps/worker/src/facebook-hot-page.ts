import type { Page } from 'playwright';

/** A long-lived Messenger page kept open by the listener and shared with the readers. */
export interface HotPage {
  accountId: string;
  page: Page;
  // Chats the page saw change and the reader has not imported yet.
  dirty: Set<string>;
  // Last time a full (every chat) import ran through this page.
  lastFullAt: number;
  queue: Promise<unknown>;
}

const pages = new Map<string, HotPage>();

export function registerHotPage(accountId: string, page: Page): HotPage {
  const hot: HotPage = {
    accountId,
    page,
    dirty: new Set(),
    lastFullAt: 0,
    queue: Promise.resolve(),
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
): Promise<T> {
  const result = hot.queue.catch(() => {}).then(() => operation(hot.page));
  hot.queue = result;
  return result;
}
