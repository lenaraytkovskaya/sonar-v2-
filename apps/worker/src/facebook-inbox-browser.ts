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
// Structure over language: Facebook labels are localized (and mixed), roles are not.
const logSelector = '[role="log"]';

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

const months = [
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
];

/**
 * Language-independent: a message row is `[data-message-id="<senderId>@msgr.<n>"]`
 * whose text is the only `div[dir="auto"]` value; the sender id decides direction.
 * Localized aria-labels are used only to keep the provider's own time string.
 */
export async function readFacebookThread(
  page: Page,
  ownId: string,
  maxMessages = 100,
) {
  return page.evaluate(
    ({ ownId, logSelector, maxMessages, months }) => {
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === 'visible' &&
        !node.closest('[hidden],[aria-hidden="true"],[inert]');
      const all = (node: ParentNode, selector: string) =>
        Array.from(node.querySelectorAll(selector)).filter(visible);
      const logs = all(document, logSelector);
      const threadId =
        /^\/messages\/(?:e2ee\/(?:requests\/)?|requests\/)?t\/(\d+)\/?$/.exec(
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
      // Boundary without language: a full conversation page has [role=main];
      // the floating chat is found by climbing to the composer's container.
      const composerSelector = '[contenteditable="true"][role="textbox"]';
      let scope: Element | null = log.closest('[role="main"]');
      if (!scope) {
        scope = log.parentElement;
        while (
          scope &&
          scope !== document.body &&
          !all(scope, composerSelector).length
        )
          scope = scope.parentElement;
        // The nearest content boundary holds log and composer; its parent also
        // holds the peer header.
        if (scope && !all(scope, 'a[href]').some((node) => !log.contains(node)))
          scope = scope.parentElement;
      }
      if (
        !scope ||
        scope === document.body ||
        all(scope, logSelector).length !== 1 ||
        all(scope, 'nav,[role="navigation"]').length > 0 ||
        all(scope, composerSelector).length > 1
      ) {
        skipped.push('peer_boundary_unverified');
        return result();
      }
      const main = scope;
      const profileId = (node: Element) => {
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
      };
      const peers = [
        ...new Set(
          all(main, 'a[href]')
            .filter((node) => !log.contains(node))
            .map(profileId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (peers.length !== 1 || peers[0] === ownId) {
        skipped.push('peer_identity_unverified');
        return result();
      }
      const peerId = peers[0]!;
      const peerLink = all(main, 'a[href]').find(
        (node) => !log.contains(node) && profileId(node) === peerId,
      );
      const peerName = (
        peerLink?.getAttribute('aria-label') ||
        peerLink?.textContent ||
        ''
      ).trim();
      const composer = all(main, composerSelector)[0];
      const composerName = composer?.getAttribute('aria-label')?.trim();
      if (peerName && composerName && !composerName.includes(peerName)) {
        skipped.push('peer_boundary_unverified');
        return result();
      }
      const peerProfile = `https://www.facebook.com/${peerId}/`;
      const observedAt = new Date().toISOString();
      const seen = new Set<string>();
      const nodes = all(log, '[data-message-id]').filter((node) => {
        const id = node.getAttribute('data-message-id') ?? '';
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (!nodes.length) skipped.push('no_message_nodes');
      for (const [providerOrder, node] of nodes.slice(-maxMessages).entries()) {
        const id = node.getAttribute('data-message-id')!;
        const parsed = /^(\d+)@msgr\.\d+$/.exec(id);
        if (!parsed) {
          skipped.push('message_id_unverified');
          continue;
        }
        const sender = parsed[1]!;
        const label = node.getAttribute('aria-label') ?? '';
        // A recognizable "You" label wins; otherwise the sender id in the
        // message id decides, which needs no language at all.
        const labelOwn = /(?:^|, )(?:You|Ви|Вы): /.test(label);
        if (!labelOwn && sender !== ownId && sender !== peerId) {
          skipped.push('sender_unverified');
          continue;
        }
        const bodies = [
          ...new Set(
            all(node, 'div[dir="auto"]')
              .map((value) => value.textContent ?? '')
              .filter(Boolean),
          ),
        ];
        if (bodies.length !== 1) {
          skipped.push('message_content_unverified');
          continue;
        }
        const body = bodies[0]!;
        // The localized label must still carry this exact text and name only
        // us or the peer, whatever the language of its wording.
        const labelPrefix = label.includes(': ')
          ? label.slice(0, label.indexOf(': '))
          : '';
        const labelSender = labelPrefix
          ? labelPrefix.slice(labelPrefix.lastIndexOf(', ') + 2).trim()
          : undefined;
        const ownWord = /^(?:You|Ви|Вы)$/.test(labelSender ?? '');
        if (
          (label && !label.includes(body)) ||
          (labelSender &&
            peerName &&
            !ownWord &&
            sender !== ownId &&
            !peerName.startsWith(labelSender) &&
            !labelSender.startsWith(peerName))
        ) {
          skipped.push('message_content_unverified');
          continue;
        }
        // The label is localized: keep its time part verbatim, and derive a
        // calendar date only from the one English shape that proves one.
        const english =
          /^At ((?:(?:\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}, |(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) ))?\d{1,2}:\d{2}), /.exec(
            label,
          );
        const providerTimestamp = (
          english?.[1] ??
          label.split(', ')[0] ??
          ''
        ).slice(0, 60);
        let occurredAt: string | null = null;
        const full =
          /^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}), (\d{2}):(\d{2})$/.exec(
            providerTimestamp,
          );
        if (full) {
          const month = months.indexOf(full[2]!);
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
        const outgoing = labelOwn || sender === ownId;
        messages.push({
          externalMessageId: id,
          providerOrder,
          threadId,
          direction: outgoing ? 'out' : 'in',
          senderProfile: outgoing
            ? `https://www.facebook.com/${ownId}/`
            : peerProfile,
          peerProfile,
          body,
          occurredAt,
          providerTimestamp: providerTimestamp || 'unknown',
          observedAt,
          threadUrl: `https://www.facebook.com${location.pathname}`,
        });
      }
      return result();
    },
    { ownId, logSelector, maxMessages, months },
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

type RestoreDialog = 'none' | 'pin' | 'continue' | 'unknown';

/**
 * Structure only: the PIN dialog holds the single six-digit one-time-code
 * input; the follow-up "continue without restoring" dialog has no input and
 * exactly two text buttons (cancel first, confirm last). Labels are localized
 * and even mixed within one dialog, so no label text is ever matched.
 */
async function restoreDialogKind(page: Page): Promise<RestoreDialog> {
  return page.evaluate((): RestoreDialog => {
    if (
      location.origin !== 'https://www.facebook.com' ||
      !/^\/messages\//.test(location.pathname)
    )
      return 'none';
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]');
    const dialog = Array.from(
      document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
    )
      .filter(visible)
      .at(-1);
    if (!dialog) return 'none';
    if (
      Array.from(
        dialog.querySelectorAll(
          'input[autocomplete="one-time-code"][maxlength="6"], input[aria-label="PIN"]',
        ),
      ).some(visible)
    )
      return 'pin';
    const textButtons = Array.from(
      dialog.querySelectorAll('[role="button"],button'),
    ).filter(
      (node) =>
        visible(node) &&
        !node.querySelector('svg') &&
        (node.textContent ?? '').trim().length > 0,
    );
    return textButtons.length === 2 &&
      !dialog.querySelector('input:not([type="hidden"])')
      ? 'continue'
      : 'unknown';
  });
}

/** The icon-only close control, or the last text button of the confirm dialog. */
async function restoreButton(page: Page, kind: 'close' | 'confirm') {
  return page.evaluateHandle((kind) => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]');
    const dialog = Array.from(
      document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
    )
      .filter(visible)
      .at(-1);
    if (!dialog) return null;
    const buttons = Array.from(
      dialog.querySelectorAll('[role="button"],button'),
    ).filter(visible);
    if (kind === 'close')
      return (
        buttons.find(
          (node) =>
            Boolean(node.querySelector('svg')) &&
            !(node.textContent ?? '').trim(),
        ) ??
        // Fallback for a text-only close control in a known language.
        buttons.find((node) =>
          /^(?:close|закрити|закрыть)$/i.test(
            (node.getAttribute('aria-label') || node.textContent || '').trim(),
          ),
        ) ??
        null
      );
    const text = buttons.filter(
      (node) =>
        !node.querySelector('svg') && (node.textContent ?? '').trim().length,
    );
    return text.length === 2 ? text[1]! : null;
  }, kind);
}

/**
 * Restores chat history with the owner's PIN when FACEBOOK_RESTORE_PIN is set
 * (six digits, typed once per run, never logged); otherwise dismisses the
 * dialogs without restoring, as before. A rejected PIN is not retried and
 * pauses the account instead of choosing "don't restore" for the owner.
 */
async function dismissRestore(page: Page, deadline: number) {
  const configured = process.env.FACEBOOK_RESTORE_PIN?.trim();
  const pin = configured && /^\d{6}$/.test(configured) ? configured : null;
  let pinTried = false;
  for (let step = 0; step < 4; step++) {
    await assertSessionNegatives(page, 'facebook');
    const kind = await restoreDialogKind(page);
    if (kind === 'none' || kind === 'unknown') return;
    if (kind === 'pin' && pin && !pinTried) {
      pinTried = true;
      const input = page
        .locator(
          '[role="dialog"][aria-modal="true"] input[autocomplete="one-time-code"][maxlength="6"]',
        )
        .last();
      await input.click({ timeout: Math.max(1, deadline - Date.now()) });
      await page.keyboard.type(pin, { delay: 60 });
      try {
        await input.waitFor({
          state: 'detached',
          timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new SocialSessionCheckError('checkpoint');
        throw error;
      }
      continue;
    }
    if (kind === 'pin' && pin) throw new SocialSessionCheckError('checkpoint');
    const button = await restoreButton(
      page,
      kind === 'pin' ? 'close' : 'confirm',
    );
    try {
      const element = button.asElement();
      if (!element) return;
      await element.click({ timeout: Math.max(1, deadline - Date.now()) });
      await page.waitForTimeout(400);
    } finally {
      await button.dispose();
    }
  }
  await assertSessionNegatives(page, 'facebook');
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
    .locator('[role="grid"], [role="table"], table')
    .filter({
      has: page.locator(
        'a[href^="/messages/t/"], a[href^="/messages/e2ee/t/"]',
      ),
    })
    .first();
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
        .locator(`${logSelector} [data-message-id]`)
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
