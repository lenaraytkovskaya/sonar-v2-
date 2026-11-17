import type { Page } from 'playwright';
import type {
  SocialInboxBatch,
  SocialInboxMessage,
} from '@sonar/core/social-inbox';
import {
  SocialSessionCheckError,
  type SocialSessionCheckDiagnostic,
} from '@sonar/core/social-session';
import {
  assertSessionNegatives,
  assertSocialSession,
  facebookSessionDiagnostic,
} from './social-send-browser.js';

const origin = 'https://www.facebook.com';
const logSelector = '[aria-label^="Messages in conversation with "]';

/** Fixed enums and capped marker counts only. Never retain page content or URLs. */
async function diagnose(
  error: unknown,
  page: Page,
  stage: SocialSessionCheckDiagnostic['stage'],
  navigationHttpStatus: number | null,
) {
  if (!(error instanceof SocialSessionCheckError) || error.diagnostic)
    return error;
  error.diagnostic = await facebookSessionDiagnostic(
    page,
    stage,
    navigationHttpStatus,
    error.errorKind ?? 'unconfirmed',
  ).catch(() => undefined);
  return error;
}

/** Only the observed English DOM contract. No transport replay or generated IDs. */
export async function readFacebookThread(
  page: Page,
  ownId: string,
  maxMessages = 100,
) {
  return page.evaluate(
    ({ ownId, logSelector, maxMessages }) => {
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === 'visible' &&
        !node.closest('[hidden],[aria-hidden="true"],[inert]');
      const all = (node: ParentNode, selector: string) =>
        Array.from(node.querySelectorAll(selector)).filter(visible);
      const logs = all(document, logSelector);
      const threadId = /^\/messages\/(?:e2ee\/)?t\/(\d+)\/?$/.exec(
        location.pathname,
      )?.[1];
      const skipped: string[] = [];
      const messages: SocialInboxMessage[] = [];
      const result = () => ({ messages, skipped });
      if (!threadId || logs.length !== 1) {
        skipped.push('thread_boundary_unverified');
        return result();
      }
      const log = logs[0]!;
      const peerName = log
        .getAttribute('aria-label')!
        .slice('Messages in conversation with '.length);
      if (!peerName || peerName === 'You') {
        skipped.push('peer_name_ambiguous');
        return result();
      }
      let scope = log.parentElement;
      const composerSelector =
        '[aria-label="Thread composer"] [aria-label^="Write to "]';
      while (
        scope &&
        scope !== document.body &&
        !all(scope, composerSelector).length
      )
        scope = scope.parentElement;
      // Captured floating chat: the nearest content boundary has the log and
      // composer; its immediate parent also contains the peer header. Fullscreen
      // conversation regions may already contain all three.
      if (scope && !all(scope, 'a[href]').some((node) => !log.contains(node)))
        scope = scope.parentElement;
      if (
        !scope ||
        scope === document.body ||
        all(scope, logSelector).length !== 1 ||
        all(scope, 'nav,[role="navigation"],[aria-label="Thread list"]')
          .length > 0 ||
        all(scope, composerSelector).length !== 1 ||
        all(scope, composerSelector)[0]!.getAttribute('aria-label') !==
          `Write to ${peerName}`
      ) {
        skipped.push('peer_boundary_unverified');
        return result();
      }
      const peers = all(scope, 'a[href]')
        .filter(
          (node) =>
            !log.contains(node) &&
            (
              node.getAttribute('aria-label') ||
              node.textContent ||
              ''
            ).trim() === peerName,
        )
        .map((node) => {
          try {
            const url = new URL(node.getAttribute('href')!, location.href);
            return url.protocol === 'https:' &&
              /^(www\.)?facebook\.com$/.test(url.hostname) &&
              !url.username &&
              !url.password &&
              /^\/\d+\/?$/.test(url.pathname)
              ? url.pathname.match(/\d+/)![0]
              : null;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => Boolean(id));
      if (peers.length !== 1 || peers[0] === ownId) {
        skipped.push('peer_identity_unverified');
        return result();
      }
      const peerProfile = `https://www.facebook.com/${peers[0]}/`;
      const observedAt = new Date().toISOString();
      const nodes = all(log, '[aria-roledescription="message"]');
      if (!nodes.length) skipped.push('no_message_nodes');
      for (const [providerOrder, node] of nodes.slice(-maxMessages).entries()) {
        const id = node.getAttribute('data-message-id');
        if (!id || !/^\d+@msgr\.\d+$/.test(id)) {
          skipped.push('message_id_unverified');
          continue;
        }
        const label = node.getAttribute('aria-label') ?? '';
        const match =
          /^At ((?:(?:\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}, |(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) ))?\d{1,2}:\d{2}), (You|.+?): ([\s\S]+)$/.exec(
            label,
          );
        if (
          !match ||
          !['You', peerName].includes(match[2]!) ||
          !all(node, 'div[dir="auto"]').some(
            (value) => value.textContent === match[3],
          )
        ) {
          skipped.push('message_content_unverified');
          continue;
        }
        // Relative display times have no proven calendar date. Keep the label and
        // observation separately; created_at is ingestion order, never provider time.
        const full =
          /^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}), (\d{2}):(\d{2})$/.exec(
            match[1]!,
          );
        let occurredAt: string | null = null;
        if (full) {
          const month = [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
          ].indexOf(full[2]!);
          const date = new Date(
            +full[3]!,
            month,
            +full[1]!,
            +full[4]!,
            +full[5]!,
          );
          if (
            date.getFullYear() === +full[3]! &&
            date.getMonth() === month &&
            date.getDate() === +full[1]! &&
            date.getHours() === +full[4]! &&
            date.getMinutes() === +full[5]!
          )
            occurredAt = date.toISOString();
        }
        const outgoing = match[2] === 'You';
        messages.push({
          externalMessageId: id,
          providerOrder,
          threadId,
          direction: outgoing ? 'out' : 'in',
          senderProfile: outgoing
            ? `https://www.facebook.com/${ownId}/`
            : peerProfile,
          peerProfile,
          body: match[3]!,
          occurredAt,
          providerTimestamp: match[1]!,
          observedAt,
          threadUrl: `https://www.facebook.com${location.pathname}`,
        });
      }
      return result();
    },
    { ownId, logSelector, maxMessages },
  );
}

/** Reads only visible request-list previews; it never follows a thread link. */
export async function readFacebookRequestPreviews(page: Page) {
  return page.evaluate(() => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible' &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]');
    const messages: SocialInboxMessage[] = [];
    const skipped: string[] = [];
    if (
      location.origin !== 'https://www.facebook.com' ||
      !/^\/messages\/requests\/?$/.test(location.pathname)
    )
      return { messages, skipped: ['requests_list_unverified'] };
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href^="/messages/t/"],a[href^="/messages/e2ee/t/"]',
      ),
    ).filter(visible);
    const seen = new Set<string>();
    for (const link of links) {
      const url = new URL(link.href);
      const threadId = /^\/messages\/(?:e2ee\/)?t\/(\d+)\/?$/.exec(
        url.pathname,
      )?.[1];
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      const row =
        link.closest('article,[role="row"],[role="listitem"],li') ??
        link.parentElement ??
        link;
      const preview = row.cloneNode(true) as HTMLElement;
      preview
        .querySelectorAll('button,[role="button"]')
        .forEach((node) => node.remove());
      preview.querySelectorAll('a[href^="/"]').forEach((node) => {
        if (
          node !== link &&
          /^\/\d+\/?$/.test(new URL((node as HTMLAnchorElement).href).pathname)
        )
          node.remove();
      });
      const text = (preview.textContent ?? link.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const profileIds = Array.from(row?.querySelectorAll('a[href]') ?? [])
        .filter(visible)
        .map((node) => {
          try {
            const profile = new URL(
              (node as HTMLAnchorElement).href,
              location.href,
            );
            return profile.origin === location.origin
              ? (/^\/(\d+)\/?$/.exec(profile.pathname)?.[1] ?? null)
              : null;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => Boolean(id));
      const peerId = [...new Set(profileIds)];
      if (!text || peerId.length !== 1) {
        skipped.push('request_preview_identity_unverified');
        continue;
      }
      const peerProfile = `https://www.facebook.com/${peerId[0]}/`;
      messages.push({
        externalMessageId: `preview:${threadId}`,
        threadId,
        threadUrl: `https://www.facebook.com${url.pathname}`,
        direction: 'in',
        senderProfile: peerProfile,
        peerProfile,
        body: text.slice(0, 2000),
        occurredAt: null,
        providerTimestamp: 'request-preview-only',
        observedAt: new Date().toISOString(),
        incomplete: true,
        incompleteReasonUk: 'Запит не відкрито, щоб не позначати прочитаним.',
      });
    }
    if (!links.length) skipped.push('requests_empty_or_unverified');
    if (links.length) skipped.push('requests_preview_only');
    return { messages, skipped };
  });
}

/** Only the non-destructive restore dismissal observed by root on 2026-11-15. */
async function dismissRestore(page: Page, deadline: number) {
  for (const step of ['pin', 'continue'] as const) {
    await assertSessionNegatives(page, 'facebook');
    const button = await page.evaluateHandle((step) => {
      if (
        location.origin !== 'https://www.facebook.com' ||
        !/^\/messages\//.test(location.pathname)
      )
        return null;
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        !node.closest('[hidden],[aria-hidden="true"],[inert]');
      const title =
        step === 'pin'
          ? 'Enter your PIN to restore your chats'
          : 'Continue without restoring?';
      const headings = Array.from(
        document.querySelectorAll('h2,[role="heading"][aria-level="2"]'),
      ).filter((node) => visible(node) && node.textContent?.trim() === title);
      if (headings.length !== 1) return null;
      // Text and ancestor coincidence do not prove a modal. Unknown boundaries
      // stay untouched until their actual semantics have been observed.
      const scope = headings[0]!.closest('[role="dialog"][aria-modal="true"]');
      if (scope) {
        const text = scope.textContent ?? '';
        const buttons = Array.from(
          scope.querySelectorAll('button,[role="button"]'),
        ).filter(visible);
        const named = (name: string) =>
          buttons.filter(
            (node) =>
              (
                node.getAttribute('aria-label') ||
                node.textContent ||
                ''
              ).trim() === name,
          );
        if (
          step === 'pin' &&
          text.includes(
            'Some messages are missing. Enter your PIN to restore your chat history.',
          ) &&
          scope.querySelector('input[aria-label="PIN"],input') &&
          named('Forgotten PIN?').length === 1 &&
          named('Close').length >= 1 &&
          named('Close').length <= 2
        )
          return named('Close')[0];
        if (
          step === 'continue' &&
          text.includes('This means that you') &&
          text.includes('full chat history on this device') &&
          named('Cancel').length === 1 &&
          named("Don't restore messages").length === 1
        )
          return named("Don't restore messages")[0];
      }
      return null;
    }, step);
    try {
      const element = button.asElement();
      if (element) {
        await element.click({ timeout: Math.max(1, deadline - Date.now()) });
        if (step === 'pin')
          await page
            .getByRole('heading', {
              name: 'Continue without restoring?',
              exact: true,
            })
            .waitFor({
              state: 'visible',
              timeout: Math.max(1, deadline - Date.now()),
            });
      }
    } finally {
      await button.dispose();
    }
    await assertSessionNegatives(page, 'facebook');
  }
}

export async function captureFacebookInbox(
  page: Page,
  ownId: string,
  timeoutMs: number,
  persist: (batch: SocialInboxBatch) => Promise<void>,
  assertSession = (budgetMs = timeoutMs) =>
    assertSocialSession(page, 'facebook', budgetMs),
  resumeAnchor: Record<string, unknown> | null = null,
  maxThreads = 50,
  maxMessages = 100,
  threadCursors: Record<string, { lastMessageId?: string }> = {},
) {
  const skipped = new Set([
    'pagination_unverified',
    'archived_folder_unverified',
  ]);
  const folderCursors: Record<string, unknown> =
    resumeAnchor?.folders !== null &&
    typeof resumeAnchor?.folders === 'object' &&
    !Array.isArray(resumeAnchor.folders)
      ? { ...(resumeAnchor.folders as Record<string, unknown>) }
      : {};
  const deadline = Date.now() + timeoutMs;
  let navigationHttpStatus: number | null = null;
  let stage: SocialSessionCheckDiagnostic['stage'] = 'navigation';
  const observed = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      throw await diagnose(error, page, stage, navigationHttpStatus);
    }
  };
  const navigate = async (url: string, end: number) => {
    stage = 'navigation';
    navigationHttpStatus = null;
    return observed(async () => {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, end - Date.now()),
      });
      navigationHttpStatus = response?.status() ?? null;
      stage = 'http';
      if (response?.status() === 429)
        throw new SocialSessionCheckError('rate_limit');
      if (!response || response.status() >= 400)
        throw new SocialSessionCheckError('unknown_auth');
      stage = 'auth';
      await assertSessionNegatives(page, 'facebook');
      stage = 'restore';
      await dismissRestore(page, end);
      stage = 'auth';
      await assertSession(Math.max(1, end - Date.now()));
    });
  };
  await navigate(`${origin}/messages/`, deadline);
  const list = page
    .getByRole('region', { name: 'Thread list', exact: true })
    .getByRole('table', { name: 'Chats', exact: true });
  try {
    await list.waitFor({
      state: 'visible',
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch {
    return {
      complete: false,
      reason: 'unsupported_dom' as const,
      skipped: ['thread_list_unverified'],
    };
  }
  const urls = await list.locator('a[href]').evaluateAll((nodes) => [
    ...new Set(
      nodes
        .map((node) => {
          const url = new URL(node.getAttribute('href')!, location.href);
          return url.origin === location.origin &&
            /^\/messages\/(?:e2ee\/)?t\/\d+\/?$/.test(url.pathname) &&
            !url.search &&
            !url.hash
            ? url.href
            : '';
        })
        .filter(Boolean),
    ),
  ]);
  if (!urls.length) skipped.add('no_visible_threads');
  if (urls.length > maxThreads) skipped.add('thread_limit_reached');
  const limitedUrls = urls.slice(0, maxThreads);
  const next =
    typeof resumeAnchor?.nextThreadUrl === 'string'
      ? limitedUrls.indexOf(resumeAnchor.nextThreadUrl)
      : -1;
  const ordered =
    next > 0
      ? [...limitedUrls.slice(next), ...limitedUrls.slice(0, next)]
      : limitedUrls;
  for (const [index, url] of ordered.entries()) {
    if (Date.now() >= deadline) {
      skipped.add('time_limit');
      break;
    }
    // Reserve room for another chat, rather than dividing a large list into
    // unusably tiny waits. The persisted rotation covers later chats next poll.
    const perThreadMs =
      ordered.length > 1 ? Math.max(1, Math.floor(timeoutMs / 2)) : timeoutMs;
    const end = Math.min(deadline, Date.now() + perThreadMs);
    let read: Awaited<ReturnType<typeof readFacebookThread>> = {
      messages: [],
      skipped: [],
    };
    try {
      await navigate(url, end);
      await page
        .locator(`${logSelector} [aria-roledescription="message"]`)
        .first()
        .waitFor({ state: 'visible', timeout: Math.max(1, end - Date.now()) });
      read = await readFacebookThread(page, ownId, maxMessages);
      const threadId = read.messages[0]?.threadId;
      const previousId = threadId
        ? threadCursors[threadId]?.lastMessageId
        : undefined;
      const previousIndex = previousId
        ? read.messages.findIndex(
            (message) => message.externalMessageId === previousId,
          )
        : -1;
      if (previousIndex >= 0)
        read.messages = read.messages.slice(previousIndex + 1);
      stage = 'capture_auth';
      await observed(() => assertSession(Math.max(1, end - Date.now())));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError')
        throw error;
      stage = 'capture_auth';
      await observed(() => assertSessionNegatives(page, 'facebook'));
      skipped.add('history_unavailable');
    }
    read.skipped.forEach((reason) => skipped.add(reason));
    folderCursors.chats = ordered[(index + 1) % ordered.length];
    await persist({
      messages: read.messages,
      resumeAnchor: {
        threadUrl: url,
        nextThreadUrl: ordered[(index + 1) % ordered.length],
        folders: { ...folderCursors },
      },
    });
  }
  if (Date.now() < deadline) {
    await navigate(`${origin}/messages/requests/`, deadline);
    const previews = await readFacebookRequestPreviews(page);
    previews.skipped.forEach((reason) => skipped.add(reason));
    folderCursors.requests = previews.messages.at(-1)?.threadId ?? null;
    await persist({
      messages: previews.messages,
      resumeAnchor: {
        nextThreadUrl: ordered[0] ?? null,
        folders: { ...folderCursors },
      },
    });
  }
  return {
    complete: false,
    reason: 'unsupported_dom' as const,
    skipped: [...skipped],
  };
}
