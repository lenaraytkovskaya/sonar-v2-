import type { Page, Response } from 'playwright';
import type {
  SocialInboxBatch,
  SocialInboxMessage,
} from '@sonar/core/social-inbox';
import { SocialSessionCheckError } from '@sonar/core/social-session';
import {
  assertSocialSession,
  socialSendBrowser,
} from './social-send-browser.js';
import {
  SocialInboxAdapterError,
  type SocialInboxAdapter,
} from './social-inbox.js';
import {
  parseInstagramInbox,
  parseInstagramRequests,
  type InstagramInboxPage,
} from './instagram-inbox-parser.js';

const origin = 'https://www.instagram.com';
const inboxContainer =
  '[data-pagelet="IGDInboxThreadListScrollableAreaPagelet"]';
const messagesContainer = '[data-pagelet="IGDMessagesList"]';

/** Passive response observation only. No request replay, credentials inspection or API queries. */
export async function captureInstagramInbox(
  page: Page,
  timeoutMs: number,
  persistBatch: (batch: SocialInboxBatch) => Promise<void>,
  assertSession = () => assertSocialSession(page, 'instagram', timeoutMs),
  expectedViewerId?: string,
) {
  if (!expectedViewerId || !/^\d+$/.test(expectedViewerId))
    throw new SocialSessionCheckError('unknown_auth');
  let pending = Promise.resolve();
  let failure: unknown;
  let revision = 0;
  // Latest pages drive UI traversal only; they never establish continuous coverage.
  const state: { inbox: InstagramInboxPage['inbox'] } = { inbox: null };
  let seenMailbox = false;
  let invalid = false;
  let mailboxId: string | null = null;
  let unprovenChain = false;
  let requestsCovered = false;
  const skipped = new Set<string>();
  const seen = new Map<string, string>();
  const threads = new Map<string, InstagramInboxPage['threads'][number]>();
  let scope = 'inbox';
  const deadline = Date.now() + timeoutMs;
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (
      url.origin !== origin ||
      url.pathname !== '/api/graphql' ||
      response.request().method() !== 'POST'
    )
      return;
    const request = response.request();
    const frame = request.frame();
    if (
      frame !== page.mainFrame() ||
      new URL(frame.url()).origin !== origin ||
      !/^\/direct\/(?:inbox\/|requests\/|t\/\d+\/?)$/.test(
        new URL(frame.url()).pathname,
      ) ||
      new URL(request.url()).origin !== origin
    ) {
      invalid = true;
      skipped.add('untrusted_response_origin');
      return;
    }
    const responseScope = scope;
    pending = pending
      .then(async () => {
        if (failure) return;
        if (response.status() === 429)
          throw new SocialSessionCheckError('rate_limit');
        if (response.status() !== 200) {
          invalid = true;
          return;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          invalid = true;
          return;
        }
        if (responseScope === `${origin}/direct/requests/`) {
          const friendlyName = new URLSearchParams(
            request.postData() ?? '',
          ).get('fb_api_req_friendly_name');
          if (friendlyName !== 'PolarisDirectMessageRequestQuery') return;
          if (!mailboxId || !parseInstagramRequests(body, mailboxId)) {
            skipped.add('requests_shape_unsupported');
            return;
          }
          await assertSession();
          requestsCovered = true;
          revision++;
          await persistBatch({ messages: [], resumeAnchor: null });
          return;
        }
        const parsed = parseInstagramInbox(body, new Date().toISOString());
        if (!parsed) return;
        await assertSession();
        if (
          !parsed.mailboxId ||
          (!mailboxId && parsed.actors.length === 0) ||
          (mailboxId !== null && parsed.mailboxId !== mailboxId) ||
          parsed.actors.some(
            (actor) =>
              actor.viewerId !== expectedViewerId ||
              actor.mailboxId !== parsed.mailboxId,
          )
        )
          throw new SocialSessionCheckError('unknown_auth');
        mailboxId ??= parsed.mailboxId;
        seenMailbox = true;
        revision++;
        if (responseScope === 'inbox') state.inbox = parsed.inbox;
        // Continuation request variables have not been captured/verified. A later
        // terminal page cannot prove that any intervening provider page was seen.
        unprovenChain ||=
          parsed.inbox?.more === true ||
          parsed.threads.some((thread) => thread.page?.more === true);
        if (!parsed.inbox) {
          invalid = true;
          skipped.add('missing_pagination');
        }
        for (const thread of parsed.threads) {
          threads.set(thread.id, thread);
          if (!thread.page) {
            invalid = true;
            skipped.add('missing_pagination');
          }
        }
        parsed.skipped.forEach((reason) => skipped.add(reason));
        const messages: SocialInboxMessage[] = [];
        for (const message of parsed.messages) {
          const key = JSON.stringify({ ...message, observedAt: undefined });
          const previous = seen.get(message.externalMessageId);
          if (previous && previous !== key) {
            invalid = true;
            skipped.add('message_identity_conflict');
          }
          if (previous) continue;
          seen.set(message.externalMessageId, key);
          messages.push(message);
        }
        // Serialize and commit each captured chunk before any further UI action.
        await persistBatch({ messages, resumeAnchor: null });
      })
      .catch((error) => {
        failure ??= error;
      });
  };
  const drain = async () => {
    let current;
    do {
      current = pending;
      await current;
    } while (current !== pending);
    if (failure) throw failure;
  };
  const waitForCapture = async (previous: number) => {
    while (Date.now() < deadline) {
      await drain();
      if (revision > previous) return true;
      await page.waitForTimeout(
        Math.min(100, Math.max(1, deadline - Date.now())),
      );
    }
    await drain();
    return revision > previous;
  };
  const navigate = async (url: string) => {
    scope = url === `${origin}/direct/inbox/` ? 'inbox' : url;
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (response?.status() === 429)
      throw new SocialSessionCheckError('rate_limit');
    if (!response || response.status() >= 400) invalid = true;
    await assertSession();
    await drain();
  };
  let listening = true;
  const detach = () => {
    if (listening) page.off('response', onResponse);
    listening = false;
  };
  page.on('response', onResponse);
  try {
    await navigate(`${origin}/direct/inbox/`);
    await waitForCapture(0);
    while (
      seenMailbox &&
      !invalid &&
      skipped.size === 0 &&
      Date.now() < deadline
    ) {
      await drain();
      const history = [...threads.values()].find((thread) => thread.page?.more);
      if (!state.inbox?.more && !history) break;
      if (history && page.url() !== history.url) {
        const before = revision;
        await navigate(history.url);
        if (!(await waitForCapture(before))) break;
        continue;
      }
      if (!history && page.url() !== `${origin}/direct/inbox/`) {
        await navigate(`${origin}/direct/inbox/`);
      }
      await assertSession();
      await drain();
      const container = page.locator(
        history ? messagesContainer : inboxContainer,
      );
      if ((await container.count()) !== 1) {
        invalid = true;
        break;
      }
      const before = revision;
      await container.evaluate((element, older) => {
        element.scrollTo({
          top: older ? 0 : element.scrollHeight,
          behavior: 'instant',
        });
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, Boolean(history));
      if (!(await waitForCapture(before))) break;
    }
    await drain();
    if (
      seenMailbox &&
      !invalid &&
      skipped.size === 0 &&
      Date.now() < deadline
    ) {
      const before = revision;
      await navigate(`${origin}/direct/requests/`);
      await waitForCapture(before);
    }
    await assertSession();
    detach();
    await drain();
    if (unprovenChain) skipped.add('pagination_chain_unverified');
    if (!requestsCovered) skipped.add('requests_and_spam_unverified');
    // No observed General fixture or reliable account capability evidence exists.
    // PRIMARY and empty Requests/spam cannot advance an account-wide watermark.
    skipped.add('general_folder_unsupported');
    return {
      complete: false,
      reason: 'unsupported_dom' as const,
      skipped: [...skipped],
    };
  } catch (error) {
    await drain();
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    return {
      complete: false,
      reason: 'unsupported_dom' as const,
      skipped: [...skipped],
    };
  } finally {
    detach();
    await drain();
  }
}

export function createSocialInboxAdapter(
  timeout: () => Promise<number>,
  browser: Pick<typeof socialSendBrowser, 'withPage'> = socialSendBrowser,
): SocialInboxAdapter {
  return {
    async sync(account, _checkpoint, persistBatch) {
      if (account.channel !== 'instagram')
        throw new SocialInboxAdapterError(
          account.channel === 'facebook' ? 'history_locked' : 'unsupported_dom',
          account.channel === 'facebook'
            ? 'Історію Facebook заблоковано PIN. Синхронізацію не активовано.'
            : 'Адаптер історії LinkedIn не підтримується; синхронізацію не активовано.',
        );
      const timeoutMs = await timeout();
      const actorCookies = account.session.cookies.filter(
        (cookie) =>
          cookie.name === 'ds_user_id' &&
          [
            '.instagram.com',
            'instagram.com',
            'www.instagram.com',
            '.www.instagram.com',
          ].includes(cookie.domain) &&
          cookie.path === '/',
      );
      if (actorCookies.length !== 1 || !/^\d+$/.test(actorCookies[0]!.value))
        throw new SocialSessionCheckError('unknown_auth');
      const expectedViewerId = actorCookies[0]!.value;
      return browser.withPage(account, account.session, timeoutMs, (page) =>
        captureInstagramInbox(
          page,
          timeoutMs,
          persistBatch,
          undefined,
          expectedViewerId,
        ),
      );
    },
  };
}
