import type { Page, Response } from 'playwright';
import { navigateSocialPage } from './social-navigation.js';
import {
  captureFacebookHot,
  captureFacebookInbox,
} from './facebook-inbox-browser.js';
import { getHotPage, runOnHotPage } from './facebook-hot-page.js';
import type {
  SocialInboxBatch,
  SocialInboxMessage,
} from '@sonar/core/social-inbox';
import { isNewSocialInboxMessage } from '@sonar/core/social-inbox';
import {
  SocialSendError,
  SocialSessionCheckError,
  type SocialSessionCheckDiagnostic,
} from '@sonar/core/social-session';
import {
  assertSocialSession,
  instagramSessionMarkers,
  waitForInstagramReady,
  socialSendBrowser,
  captureFailureShot,
} from './social-send-browser.js';
import {
  SocialInboxAdapterError,
  type SocialInboxAdapter,
} from './social-inbox.js';
import {
  parseInstagramInbox,
  parseInstagramRequests,
  readInstagramInboxDom,
  type InstagramInboxPage,
} from './instagram-inbox-parser.js';

const origin = 'https://www.instagram.com';
const inboxContainer =
  '[data-pagelet="IGDInboxThreadListScrollableAreaPagelet"]';
const messagesContainer = '[data-pagelet="IGDMessagesList"]';
type CaptureDiagnostic = NonNullable<SocialSessionCheckDiagnostic['capture']>;
type ActorDiagnostic = NonNullable<SocialSessionCheckDiagnostic['actor']>;
const emptyCapture = (): CaptureDiagnostic => ({
  received: 0,
  parsed: 0,
  verified: 0,
  persisted: 0,
  httpStatus: null,
});

async function diagnose(
  error: unknown,
  page: Page | undefined,
  stage: SocialSessionCheckDiagnostic['stage'],
  navigationHttpStatus: number | null,
  capture: CaptureDiagnostic,
  actor?: ActorDiagnostic,
) {
  if (!(error instanceof SocialSessionCheckError) || error.diagnostic)
    return error;
  // Collect before page closure. A diagnostic failure must not replace the reason.
  error.diagnostic = await (async (): Promise<SocialSessionCheckDiagnostic> => {
    const url = new URL(page?.url() ?? 'about:blank');
    const path = url.pathname;
    const urlKind =
      url.origin !== origin
        ? 'other'
        : /captcha/i.test(path)
          ? 'captcha'
          : /checkpoint|challenge|security\/verification/i.test(path)
            ? 'checkpoint'
            : /login|signin|authwall/i.test(path)
              ? 'login'
              : /^\/direct\/inbox\/?$/.test(path)
                ? 'inbox'
                : /^\/direct\/requests\/?$/.test(path)
                  ? 'requests'
                  : /^\/direct\/t\/\d+\/?$/.test(path)
                    ? 'thread'
                    : 'other';
    return {
      version: 1,
      stage:
        'screen' in error && error.screen === 'splash' ? 'navigation' : stage,
      ...('screen' in error && error.screen === 'splash'
        ? { screen: 'splash' as const }
        : {}),
      urlKind,
      navigationHttpStatus,
      errorKind: error.errorKind ?? 'unconfirmed',
      visible: page
        ? await instagramSessionMarkers(page)
        : {
            legacyAuth: 0,
            semanticAuth: 0,
            captcha: 0,
            checkpoint: 0,
            login: 0,
          },
      capture: { ...capture },
      ...(actor ? { actor } : {}),
    };
  })().catch(() => undefined);
  return error;
}

/** Passive response observation only. No request replay, credentials inspection or API queries. */
export async function captureInstagramInbox(
  page: Page,
  timeoutMs: number,
  persistBatch: (batch: SocialInboxBatch) => Promise<void>,
  assertSession = () => assertSocialSession(page, 'instagram', timeoutMs),
  expectedViewerId?: string,
  maxThreads = 50,
  maxMessages = 100,
  threadCursors: Record<
    string,
    { lastMessageAt?: string; lastMessageIds?: string[] }
  > = {},
  folderCursors: Record<string, string | null> = {},
) {
  const capture = emptyCapture();
  let navigationHttpStatus: number | null = null;
  const diagnosed = (
    error: unknown,
    stage: SocialSessionCheckDiagnostic['stage'],
    actor?: ActorDiagnostic,
  ) => diagnose(error, page, stage, navigationHttpStatus, capture, actor);
  const checkSession = async (stage: 'auth' | 'capture_auth') => {
    try {
      await assertSession();
    } catch (error) {
      throw await diagnosed(error, stage);
    }
  };
  if (!expectedViewerId || !/^\d+$/.test(expectedViewerId))
    throw await diagnosed(
      new SocialSessionCheckError('unknown_auth'),
      'identity',
    );
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
  let ignoredQuery = false;
  const skippedReasons = () => [
    ...skipped,
    ...(ignoredQuery ? ['unsupported_query_ignored'] : []),
  ];
  const seen = new Map<string, string>();
  const threads = new Map<string, InstagramInboxPage['threads'][number]>();
  const threadMessageCounts = new Map<string, number>();
  let scope: 'primary' | 'general' | 'requests' = 'primary';
  const deadline = Date.now() + timeoutMs;
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (
      url.origin !== origin ||
      url.pathname !== '/api/graphql' ||
      response.request().method() !== 'POST'
    )
      return;
    capture.received = Math.min(capture.received + 1, 2);
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
    const friendlyNames = new URLSearchParams(request.postData() ?? '').getAll(
      'fb_api_req_friendly_name',
    );
    // Unread-count and other ancillary queries share the mailbox envelope but
    // select no actor/messages. Only captured full query selections are eligible.
    const expectedQuery =
      responseScope === 'requests'
        ? 'PolarisDirectMessageRequestQuery'
        : 'PolarisDirectInboxQuery';
    let stage: SocialSessionCheckDiagnostic['stage'] = 'http';
    let actor: ActorDiagnostic | undefined;
    pending = pending
      .then(async () => {
        if (failure) return;
        capture.httpStatus = response.status();
        if (response.status() === 429)
          throw new SocialSessionCheckError('rate_limit');
        if (response.status() !== 200) {
          invalid = true;
          return;
        }
        if (friendlyNames.length !== 1 || friendlyNames[0] !== expectedQuery) {
          ignoredQuery = true;
          return;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          invalid = true;
          return;
        }
        if (responseScope === 'requests') {
          if (mailboxId && parseInstagramRequests(body, mailboxId)) {
            capture.parsed = Math.min(capture.parsed + 1, 2);
            await checkSession('capture_auth');
            capture.verified = Math.min(capture.verified + 1, 2);
            requestsCovered = true;
            folderCursors.requests = null;
            state.inbox = { more: false, cursor: null };
            revision++;
            stage = 'persist';
            await persistBatch({
              messages: [],
              resumeAnchor: {
                folders: { ...folderCursors },
                activeFolder: 'requests',
              },
            });
            capture.persisted = Math.min(capture.persisted + 1, 2);
            return;
          }
        }
        const expectedFolder =
          responseScope === 'general'
            ? 'GENERAL'
            : responseScope === 'requests'
              ? 'REQUESTS'
              : 'PRIMARY';
        const parsed = parseInstagramInbox(
          body,
          new Date().toISOString(),
          expectedFolder,
        );
        if (!parsed) return;
        capture.parsed = Math.min(capture.parsed + 1, 2);
        await checkSession('capture_auth');
        // An empty response carries no viewer proof. It cannot bind identity or
        // replace pagination from an attributable response, even after binding.
        if (
          parsed.emptyEdges &&
          parsed.mailboxId &&
          parsed.inbox &&
          parsed.skipped.length === 0 &&
          (mailboxId === null || parsed.mailboxId === mailboxId)
        )
          return;
        stage = 'actor';
        // Preserve the original rejection predicates; classify without adopting another namespace.
        const reason: ActorDiagnostic['reason'] | undefined = !parsed.mailboxId
          ? 'mailbox_missing'
          : !mailboxId && parsed.actors.length === 0
            ? 'initial_actors_empty'
            : mailboxId !== null && parsed.mailboxId !== mailboxId
              ? 'mailbox_changed'
              : parsed.actors.some(
                    (value) => value.viewerId !== expectedViewerId,
                  )
                ? 'viewer_mismatch'
                : parsed.actors.some(
                      (value) => value.mailboxId !== parsed.mailboxId,
                    )
                  ? 'actor_mailbox_mismatch'
                  : undefined;
        if (reason) {
          const hasActors = parsed.actors.length > 0;
          const failedActor =
            reason === 'viewer_mismatch'
              ? parsed.actors.find(
                  (value) => value.viewerId !== expectedViewerId,
                )
              : reason === 'actor_mailbox_mismatch'
                ? parsed.actors.find(
                    (value) => value.mailboxId !== parsed.mailboxId,
                  )
                : undefined;
          // Missing/invalid fields cannot evidence a different actor. This only
          // labels the existing rejection; it never authorizes another shape.
          const unsupportedShape =
            failedActor &&
            (reason === 'viewer_mismatch'
              ? failedActor.fields.viewerId !== 'digit_string'
              : failedActor.fields.mailboxId !== 'digit_string');
          actor = {
            reason: unsupportedShape ? 'actor_shape_unsupported' : reason,
            hasPreviousMailbox: mailboxId !== null,
            hasMailbox: Boolean(parsed.mailboxId),
            hasActors,
            emptyEdges: parsed.emptyEdges,
            allViewersMatchExpected:
              hasActors &&
              parsed.actors.every(
                (value) => value.viewerId === expectedViewerId,
              ),
            anyViewerMatchesExpected: parsed.actors.some(
              (value) => value.viewerId === expectedViewerId,
            ),
            anyActorMailboxMatchesExpected: parsed.actors.some(
              (value) => value.mailboxId === expectedViewerId,
            ),
            responseMailboxMatchesExpected:
              parsed.mailboxId === expectedViewerId,
            allActorMailboxesMatchResponse:
              hasActors &&
              parsed.actors.every(
                (value) => value.mailboxId === parsed.mailboxId,
              ),
            ...(failedActor ? { fields: failedActor.fields } : {}),
          };
          throw new SocialSessionCheckError('unknown_auth');
        }
        capture.verified = Math.min(capture.verified + 1, 2);
        mailboxId ??= parsed.mailboxId;
        seenMailbox = true;
        revision++;
        state.inbox = parsed.inbox;
        // Continuation request variables have not been captured/verified. A later
        // terminal page cannot prove that any intervening provider page was seen.
        unprovenChain ||=
          parsed.inbox?.more === true ||
          parsed.threads.some((thread) => thread.page?.more === true);
        if (!parsed.inbox && responseScope !== 'requests') {
          invalid = true;
          skipped.add('missing_pagination');
        }
        for (const thread of parsed.threads) {
          if (!threads.has(thread.id) && threads.size >= maxThreads) {
            skipped.add('thread_limit_reached');
            continue;
          }
          threads.set(thread.id, thread);
          if (!thread.page) {
            invalid = true;
            skipped.add('missing_pagination');
          }
        }
        parsed.skipped.forEach((reason) => skipped.add(reason));
        const messages: SocialInboxMessage[] = [];
        for (const message of parsed.messages) {
          if (
            !isNewSocialInboxMessage(message, threadCursors[message.threadId])
          )
            continue;
          const count = threadMessageCounts.get(message.threadId) ?? 0;
          if (count >= maxMessages) continue;
          const key = JSON.stringify({ ...message, observedAt: undefined });
          const previous = seen.get(message.externalMessageId);
          if (previous && previous !== key) {
            invalid = true;
            skipped.add('message_identity_conflict');
          }
          if (previous) continue;
          seen.set(message.externalMessageId, key);
          messages.push(message);
          threadMessageCounts.set(message.threadId, count + 1);
        }
        // Serialize and commit each captured chunk before any further UI action.
        if (parsed.inbox) folderCursors[responseScope] = parsed.inbox.cursor;
        if (responseScope === 'requests') requestsCovered = true;
        stage = 'persist';
        await persistBatch({
          messages,
          resumeAnchor: {
            folders: { ...folderCursors },
            activeFolder: responseScope,
          },
        });
        capture.persisted = Math.min(capture.persisted + 1, 2);
      })
      .catch(async (error) => {
        failure ??= await diagnosed(error, stage, actor);
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
    scope = url === `${origin}/direct/requests/` ? 'requests' : 'primary';
    let stage: SocialSessionCheckDiagnostic['stage'] = 'navigation';
    try {
      navigationHttpStatus = null;
      const response = await navigateSocialPage(
        page,
        url,
        Math.max(1, deadline - Date.now()),
      );
      navigationHttpStatus = response?.status() ?? null;
      stage = 'http';
      if (navigationHttpStatus === 429)
        throw new SocialSessionCheckError('rate_limit');
      if (!response || response.status() >= 400) invalid = true;
      if (typeof page.waitForFunction === 'function') {
        stage = 'navigation';
        const reloaded = await waitForInstagramReady(
          page,
          Math.max(1, deadline - Date.now()),
        );
        if (reloaded) {
          navigationHttpStatus = reloaded.status();
          if (navigationHttpStatus === 429)
            throw new SocialSessionCheckError('rate_limit');
          if (navigationHttpStatus >= 400) invalid = true;
        }
      }
      await checkSession('auth');
    } catch (error) {
      throw await diagnosed(error, stage);
    }
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
      await checkSession('auth');
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
    if (seenMailbox && !invalid && Date.now() < deadline) {
      const dom = await readInstagramInboxDom(page).catch(() => null);
      const generalTabs = page
        .getByRole('tab', { name: /^(General|Загальні|Общие)$/i })
        .or(page.getByRole('button', { name: /^(General|Загальні|Общие)$/i }));
      if ((await generalTabs.count()) === 1) {
        scope = 'general';
        const before = revision;
        await generalTabs.click({
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (!(await waitForCapture(before)))
          skipped.add('general_folder_unverified');
        while (
          seenMailbox &&
          !invalid &&
          state.inbox?.more &&
          Date.now() < deadline
        ) {
          await checkSession('auth');
          const container = page.locator(inboxContainer);
          if ((await container.count()) !== 1) {
            invalid = true;
            break;
          }
          const previous = revision;
          await container.evaluate((element) => {
            element.scrollTo({
              top: element.scrollHeight,
              behavior: 'instant',
            });
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          if (!(await waitForCapture(previous))) break;
        }
      } else if (!dom?.messages || !dom.requests || dom.general)
        skipped.add('general_folder_unsupported');
    }
    if (seenMailbox && !invalid && Date.now() < deadline) {
      const before = revision;
      await navigate(`${origin}/direct/requests/`);
      await waitForCapture(before);
      while (
        requestsCovered &&
        !invalid &&
        state.inbox?.more &&
        Date.now() < deadline
      ) {
        await checkSession('auth');
        const container = page.locator(inboxContainer);
        if ((await container.count()) !== 1) {
          invalid = true;
          break;
        }
        const previous = revision;
        await container.evaluate((element) => {
          element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        if (!(await waitForCapture(previous))) break;
      }
    }
    await checkSession('auth');
    detach();
    await drain();
    if (!seenMailbox) skipped.add('no_verified_mailbox');
    if (unprovenChain) skipped.add('pagination_chain_unverified');
    if (!requestsCovered) skipped.add('requests_and_spam_unverified');
    return {
      complete: false,
      reason: 'unsupported_dom' as const,
      skipped: skippedReasons(),
    };
  } catch (error) {
    await drain();
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    if (!seenMailbox) skipped.add('no_verified_mailbox');
    return {
      complete: false,
      reason: 'unsupported_dom' as const,
      skipped: skippedReasons(),
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
    async sync(account, checkpoint, persistBatch) {
      if (account.channel === 'facebook') {
        const actors = account.session.cookies.filter(
          (cookie) =>
            cookie.name === 'c_user' &&
            [
              '.facebook.com',
              'facebook.com',
              'www.facebook.com',
              '.www.facebook.com',
            ].includes(cookie.domain) &&
            cookie.path === '/',
        );
        if (
          actors.length !== 1 ||
          !/^\d+$/.test(actors[0]!.value) ||
          account.session.cookies.some(
            (cookie) =>
              cookie.name === 'i_user' && cookie.value !== actors[0]!.value,
          )
        )
          throw new SocialSessionCheckError('unknown_auth');
        const timeoutMs = await timeout();
        const hot = getHotPage(account.id);
        if (hot) {
          // The long-lived page already sees every change, so a regular run only
          // imports the chats it flagged. A full pass still runs now and then as a
          // safety net for anything the page missed.
          const { sonarPool } = await import('@sonar/db');
          const {
            rows: [fullSetting],
          } = await sonarPool.query(
            "select value from settings where key='social.inbox.full_sync_seconds'",
          );
          const fullMs = (Number(fullSetting?.value) || 900) * 1000;
          if (Date.now() - hot.lastFullAt < fullMs) {
            const hrefs = [...hot.dirty];
            hot.dirty.clear();
            if (!hrefs.length)
              return { complete: false, skipped: ['pagination_unverified'] };
            try {
              return await runOnHotPage(hot, (page) =>
                captureFacebookHot(
                  page,
                  actors[0]!.value,
                  hrefs,
                  timeoutMs,
                  persistBatch,
                  checkpoint.resumeAnchor ?? null,
                  Number(account.settings.inboxMaxMessages) || 100,
                  (checkpoint.threadCursors ?? {}) as Record<
                    string,
                    { lastMessageId?: string }
                  >,
                ),
              );
            } catch (error) {
              hrefs.forEach((href) => hot.dirty.add(href));
              if (
                error instanceof SocialSendError ||
                error instanceof SocialSessionCheckError
              )
                throw error;
              // Anything else: fall back to a full pass on a fresh page.
            }
          }
        }
        return browser.withPage(
          account,
          account.session,
          timeoutMs,
          async (page) => {
            if (hot) hot.lastFullAt = Date.now();
            const result = await captureFacebookInbox(
              page,
              actors[0]!.value,
              timeoutMs,
              persistBatch,
              undefined,
              checkpoint.resumeAnchor,
              Number(account.settings.inboxMaxThreads) || 50,
              Number(account.settings.inboxMaxMessages) || 100,
              (checkpoint.threadCursors ?? {}) as Record<
                string,
                { lastMessageId?: string }
              >,
            );
            if (!result.complete || result.reason)
              await captureFailureShot(page, account.session, 'inbox', 'sync');
            return result;
          },
          false,
          { kind: 'inbox', stage: () => 'sync' },
        );
      }
      if (account.channel !== 'instagram')
        throw new SocialInboxAdapterError(
          'unsupported_dom',
          'Адаптер історії LinkedIn не підтримується; синхронізацію не активовано.',
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
        throw await diagnose(
          new SocialSessionCheckError('unknown_auth'),
          undefined,
          'identity',
          null,
          emptyCapture(),
        );
      const expectedViewerId = actorCookies[0]!.value;
      return browser.withPage(
        account,
        account.session,
        timeoutMs,
        async (page) => {
          const result = await captureInstagramInbox(
            page,
            timeoutMs,
            persistBatch,
            undefined,
            expectedViewerId,
            Number(account.settings.inboxMaxThreads) || 50,
            Number(account.settings.inboxMaxMessages) || 100,
            (checkpoint.threadCursors ?? {}) as Record<
              string,
              { lastMessageAt?: string; lastMessageIds?: string[] }
            >,
            (checkpoint.resumeAnchor?.folders ?? {}) as Record<
              string,
              string | null
            >,
          );
          if (!result.complete || result.reason)
            await captureFailureShot(page, account.session, 'inbox', 'sync');
          return result;
        },
        false,
        { kind: 'inbox', stage: () => 'sync' },
      );
    },
  };
}
