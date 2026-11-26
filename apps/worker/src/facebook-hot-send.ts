import type { JSHandle, Page } from 'playwright';
import { facebookSendNetwork } from './facebook-send-network.js';
import { socialTarget, type SocialTarget } from '@sonar/core';
import {
  SocialSendError,
  type FacebookDispatchResult,
} from '@sonar/core/social-session';
import {
  dismissRestore,
  readFacebookThread,
} from './facebook-inbox-browser.js';
import { noteHot, runOnHotPage, type HotPage } from './facebook-hot-page.js';

const EDITOR =
  '[contenteditable="true"][role="textbox"][data-lexical-editor="true"]';
const LOG = '[role="log"]';
// How long to wait for the sent message to show up as a new outgoing row.
const CONFIRM_MS = 15000;
const POLL_MS = 250;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const trimSlash = (path: string) => path.replace(/\/$/, '');

export interface HotSendInput {
  target: SocialTarget;
  threadId: string;
  body: string;
  ownId: string;
  timeoutMs: number;
  beforeFill: () => Promise<void>;
  beforeSend: () => Promise<void>;
  assertSession: (timeoutMs?: number) => Promise<void>;
  confirmMs?: number;
  captureFailure?: (phase: string, elapsedMs: number) => Promise<unknown>;
}

/**
 * Sends into an already known chat through the long-lived Messenger page.
 * Returns null when nothing was sent and the caller must use the normal flow.
 * After the single Enter there is no fallback: an unseen message is uncertain.
 */
export async function sendFacebookHot(
  hot: HotPage,
  input: HotSendInput,
): Promise<FacebookDispatchResult | null> {
  // A waiting send makes the background sweep step aside.
  hot.pendingSends++;
  // Background operations yield at their cooperative waits; the queue owns
  // navigation cancellation so a second send cannot interrupt the first.
  const send = async (page: Page): Promise<FacebookDispatchResult | null> => {
    const { target, threadId, body, ownId, timeoutMs } = input;
    const operationStarted = Date.now();
    const network = facebookSendNetwork(page);
    let phase = 'hot_navigation';
    const capture = () =>
      input
        .captureFailure?.(phase, Date.now() - operationStarted)
        .catch(() => {});
    const decline = async (why: string) => {
      noteHot(hot, `send declined: ${why}`);
      await capture();
      return null;
    };
    if (!/^\d+$/.test(threadId) || !body.trim()) return decline('input');
    const deadline = Date.now() + Math.min(timeoutMs, 30000);
    const left = () => Math.max(1, deadline - Date.now());
    const paths = [`/messages/e2ee/t/${threadId}`, `/messages/t/${threadId}`];
    let marked = false;
    let filled = false;
    let baseline:
      | JSHandle<{
          isNew: (id: string) => boolean;
          acceptedWithoutId: () => { count: number; stable: boolean };
        }>
      | undefined;
    try {
      const current = trimSlash(new URL(page.url()).pathname);
      if (!paths.includes(current)) {
        let opened = false;
        for (const path of paths) {
          const link = page.locator(`a[href="${path}/"], a[href="${path}"]`);
          if (await link.count()) {
            if (path.includes('/e2ee/')) {
              // A click leaves an encrypted chat on "loading messages".
              await page.goto(`https://www.facebook.com${path}/`, {
                waitUntil: 'domcontentloaded',
                timeout: left(),
              });
              await dismissRestore(page, deadline);
            } else {
              await link.first().click({ timeout: left() });
              await dismissRestore(page, deadline);
              await page.waitForURL(
                (url) => paths.includes(trimSlash(url.pathname)),
                { timeout: left() },
              );
            }
            opened = true;
            break;
          }
        }
        if (!opened) return decline('chat not in list');
      }
      hot.primary = `${trimSlash(new URL(page.url()).pathname)}/`;
      phase = 'hot_thread';
      await page
        .locator(`${LOG} [data-message-id]`)
        .first()
        .waitFor({ state: 'visible', timeout: Math.min(left(), 3000) });
      const before = await readFacebookThread(page, ownId, 200);
      if (before.threadId !== threadId) return decline('thread mismatch');
      if (socialTarget(before.peerProfile ?? '')?.handle !== target.handle)
        return decline('peer boundary unverified');
      if (!before.composerVerified)
        return decline('composer boundary unverified');
      const editor = page.locator(EDITOR).filter({ visible: true });
      if ((await editor.count()) !== 1) return decline('composer count');
      if (normalize(await editor.innerText()) !== '')
        return decline('composer not empty');
      const known = new Set(before.messageIds);
      const outgoingBefore = before.messages.filter(
        (message) => message.direction === 'out',
      ).length;
      await input.beforeFill();
      phase = 'hot_fill';
      await editor.click({ timeout: left() });
      filled = true;
      await editor.fill(body);
      if (normalize(await editor.innerText()) !== normalize(body)) {
        await editor.fill('');
        return decline('text mismatch');
      }
      await input.assertSession(left());
      // From here a failure can no longer fall back to the normal flow.
      marked = true;
      phase = 'hot_marker';
      await input.beforeSend();
      const startedAt = Date.now();
      // Exactly one dispatch; nothing below may press it again.
      phase = 'hot_dispatch';
      const dispatch = await readFacebookThread(page, ownId, 200);
      if (
        !dispatch.composerVerified ||
        dispatch.threadId !== threadId ||
        socialTarget(dispatch.peerProfile ?? '')?.handle !== target.handle ||
        (await editor.count()) !== 1
      )
        throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
      for (const id of dispatch.messageIds) known.add(id);
      if (normalize(await editor.innerText()) !== normalize(body))
        throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
      // Snapshot the DOM immediately before the only dispatch. Provider IDs can
      // arrive later, including on old ID-less rows, so raw IDs alone are not a
      // sufficient baseline. Retain ID/signature counts across React remounts.
      baseline = await page.evaluateHandle(
        ({ body, ownId }) => {
          const normalize = (text: string | null) =>
            (text ?? '').replace(/\s+/g, ' ').trim();
          const visible = (node: Element) =>
            node.getClientRects().length > 0 &&
            getComputedStyle(node).visibility === 'visible' &&
            !node.closest('[hidden], [aria-hidden="true"], [inert]');
          const logs = Array.from(
            document.querySelectorAll('[role="log"]'),
          ).filter(visible);
          let log = logs.length === 1 ? logs[0]! : null;
          const exactTail = (label: string | null) =>
            normalize(label).endsWith(': ' + normalize(body)) ||
            normalize(label).endsWith(': «' + normalize(body) + '»');
          const ownSent = (button: Element) =>
            visible(button) &&
            /^Enter, (?:Message sent .+ by You: |Повідомлення від користувача (?:Ви|Вы) о .+: |Сообщение от пользователя Вы в .+: )/s.test(
              button.getAttribute('aria-label') ?? '',
            ) &&
            exactTail(button.getAttribute('aria-label'));
          const sent = (node: Element) =>
            Array.from(
              node.querySelectorAll(
                'button[aria-label], [role="button"][aria-label]',
              ),
            ).filter(ownSent);
          const messageRows = (node: Element) =>
            Array.from(
              node.querySelectorAll('[aria-label], [data-message-id]'),
            ).filter(
              (row) =>
                row.hasAttribute('data-message-id') ||
                row.getAttribute('aria-roledescription') === 'message' ||
                (/(?:^|, )(?:You|Ви|Вы): /.test(
                  row.getAttribute('aria-label') ?? '',
                ) &&
                  row.querySelector('h2, [role="heading"]')),
            );
          const selector =
            '[data-message-id], [aria-roledescription="message"], [role="article"]';
          const rows = Array.from(log?.querySelectorAll(selector) ?? []);
          const ids = new Set(
            rows
              .map((row) => row.getAttribute('data-message-id'))
              .filter(Boolean),
          );
          const signature = (row: Element) =>
            JSON.stringify([
              row.getAttribute('aria-label'),
              Array.from(row.querySelectorAll('div[dir="auto"]')).map(
                (node) => node.textContent,
              ),
            ]);
          const signatures = new Set(
            rows.filter((row) => row.hasAttribute('aria-label')).map(signature),
          );
          const exactRows = () =>
            Array.from(log?.querySelectorAll(selector) ?? []).filter((row) => {
              const label = row.getAttribute('aria-label') ?? '';
              const id = row.getAttribute('data-message-id') ?? '';
              return (
                visible(row) &&
                (/(?:^|, )(?:You|Ви|Вы): /.test(label) ||
                  id.startsWith(ownId + '@msgr.')) &&
                Array.from(row.querySelectorAll('div[dir="auto"]')).some(
                  (node) => normalize(node.textContent) === normalize(body),
                )
              );
            });
          const beforeCount = exactRows().length;
          const boundary = () => {
            const current = Array.from(
              document.querySelectorAll('[role="log"]'),
            ).filter(visible);
            log = current.length === 1 ? current[0]! : null;
            return Boolean(log);
          };
          const fresh = (row: Element) =>
            boundary() &&
            exactRows().length === beforeCount + 1 &&
            !ids.has(row.getAttribute('data-message-id')) &&
            !signatures.has(signature(row)) &&
            Array.from(log!.querySelectorAll('[data-message-id]'))
              .filter((old) => ids.has(old.getAttribute('data-message-id')))
              .every((old) =>
                Boolean(
                  old.compareDocumentPosition(row) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
                ),
              );
          const settled = (
            row: Element,
            wrapper: Element,
            buttons: Element[] = [],
          ) => {
            const bodies = Array.from(row.querySelectorAll('div[dir="auto"]'));
            return ![
              wrapper,
              ...Array.from(wrapper.querySelectorAll('*')),
            ].some(
              (node) =>
                visible(node) &&
                (node.matches('[aria-busy="true"], [role="progressbar"]') ||
                  (!bodies.some((body) => body.contains(node)) &&
                    !buttons.some((button) => button.contains(node)) &&
                    /\b(?:sending|pending|failed|not sent|retry|couldn.t send)\b|надсилається|не надіслано|повторити|помилка|отправляется|не отправлено|повторить|ошибка/i.test(
                      [
                        node === row
                          ? ''
                          : (node.getAttribute('aria-label') ?? ''),
                        Array.from(node.childNodes)
                          .filter((child) => child.nodeType === Node.TEXT_NODE)
                          .map((child) => child.textContent)
                          .join(' '),
                      ].join(' '),
                    ))),
            );
          };
          let stable = false;
          let stableSince = performance.now();
          return {
            isNew: (id: string) => {
              if (!boundary() || ids.has(id)) return false;
              const matches = Array.from(
                log!.querySelectorAll('[data-message-id]'),
              ).filter(
                (row) =>
                  row.getAttribute('data-message-id') === id && visible(row),
              );
              if (matches.length !== 1) return false;
              const row = matches[0]!;
              return (
                fresh(row) &&
                settled(
                  row,
                  row.closest('[role="article"]') ?? row,
                  sent(row.closest('[role="article"]') ?? row),
                )
              );
            },
            acceptedWithoutId: () => {
              if (!boundary()) return { count: 0, stable: false };
              const matches = Array.from(
                log!.querySelectorAll('[aria-label]'),
              ).filter((row) => {
                const label = normalize(row.getAttribute('aria-label'));
                if (
                  !visible(row) ||
                  !fresh(row) ||
                  row.hasAttribute('data-message-id') ||
                  !/(?:^|, )(?:You|Ви|Вы): /.test(label) ||
                  !exactTail(label) ||
                  !Array.from(
                    row.querySelectorAll('h2, [role="heading"]'),
                  ).some((heading) =>
                    /^(?:You sent|Ви надіслали|Вы отправили)$/.test(
                      normalize(heading.textContent),
                    ),
                  )
                )
                  return false;
                const bodies = Array.from(
                  row.querySelectorAll('div[dir="auto"]'),
                ).filter(visible);
                if (
                  bodies.length !== 1 ||
                  normalize(bodies[0]!.textContent) !== normalize(body)
                )
                  return false;
                const article = row.closest('[role="article"]');
                let wrapper = article ?? row.parentElement;
                while (
                  wrapper &&
                  wrapper !== log &&
                  !article &&
                  sent(wrapper).length === 0 &&
                  messageRows(wrapper).length === 1
                )
                  wrapper = wrapper.parentElement;
                if (
                  !wrapper ||
                  wrapper === log ||
                  messageRows(wrapper).length !== 1
                )
                  return false;
                const buttons = sent(wrapper);
                const sentLabel = normalize(
                  buttons[0]?.getAttribute('aria-label') ?? '',
                );
                return (
                  buttons.length === 1 &&
                  !wrapper.closest('[data-message-id]') &&
                  !wrapper.querySelector('[data-message-id]') &&
                  (sentLabel.endsWith(': ' + normalize(body)) ||
                    sentLabel.endsWith(': «' + normalize(body) + '»')) &&
                  settled(row, wrapper, buttons)
                );
              });
              if (matches.length !== 1 || !stable) {
                stable = matches.length === 1;
                stableSince = performance.now();
              }
              return {
                count: matches.length,
                stable:
                  matches.length === 1 &&
                  performance.now() - stableSince >= 250,
              };
            },
          };
        },
        { body, ownId },
      );
      network.arm({ body, ownId, threadId, knownIds: [...known] });
      await editor.press('Enter');
      phase = 'hot_confirmation';
      let unconfirmed = 'new_outgoing_not_observed';
      try {
        for (;;) {
          const acknowledgement = network.result();
          if (acknowledgement)
            return {
              outcome: 'facebook_network_confirmed',
              dialogUrl: target.canonicalUrl,
              threadId,
              externalMessageId: acknowledgement.externalMessageId,
              observation: {
                inputExactMatch: true,
                dispatchPerformed: true,
                outgoingBefore: Math.min(99, outgoingBefore),
                outgoingAfter: Math.min(99, outgoingBefore + 1),
                newOutgoing: true,
                observationMs: Date.now() - startedAt,
                lateError: 'none',
              },
            };
          const after = await readFacebookThread(page, ownId, 200);
          if (
            !network.result() &&
            (after.threadId !== threadId ||
              socialTarget(after.peerProfile ?? '')?.handle !== target.handle ||
              !after.composerVerified)
          ) {
            unconfirmed = 'conversation_unverified';
            if (Date.now() - startedAt >= (input.confirmMs ?? CONFIRM_MS))
              break;
            await page.waitForTimeout(POLL_MS);
            continue;
          }
          const candidates = after.messages.filter(
            (message) =>
              message.direction === 'out' &&
              message.threadId === threadId &&
              socialTarget(message.peerProfile)?.handle === target.handle &&
              !known.has(message.externalMessageId) &&
              normalize(message.body) === normalize(body),
          );
          const added = [];
          for (const message of candidates)
            if (
              await baseline.evaluate(
                (state, id) => state.isNew(id),
                message.externalMessageId,
              )
            )
              added.push(message);
          const withoutId = await baseline.evaluate((state) =>
            state.acceptedWithoutId(),
          );
          const expired =
            Date.now() - startedAt >= (input.confirmMs ?? CONFIRM_MS);
          if (added.length + withoutId.count > 1) {
            unconfirmed = 'multiple_new_outgoing';
            break;
          }
          // Prefer the provider ID while it hydrates. A stable explicit sent
          // control can prove dispatch even if Facebook never exposes an ID.
          if (
            (added.length === 1 &&
              Date.now() - startedAt >=
                Math.min(input.confirmMs ?? CONFIRM_MS, 1000)) ||
            (expired && withoutId.stable)
          ) {
            const externalMessageId = added[0]?.externalMessageId;
            const read = Boolean(
              externalMessageId && after.seenMessageId === externalMessageId,
            );
            // A new bubble proves a dispatch, not a delivery receipt. Only the
            // peer's marker on that exact message supports the stronger state.
            noteHot(
              hot,
              read
                ? 'send confirmed: read_receipt_observed'
                : 'send unconfirmed: read_receipt_not_observed; delivery_receipt_unavailable; new_outgoing_observed',
            );
            return {
              outcome: 'facebook_dispatched_unconfirmed',
              dialogUrl: target.canonicalUrl,
              threadId,
              externalMessageId,
              ...(read
                ? {
                    readReceipt: {
                      threadId,
                      seenMessageId: externalMessageId!,
                    },
                  }
                : {}),
              observation: {
                inputExactMatch: true,
                dispatchPerformed: true,
                outgoingBefore: Math.min(99, outgoingBefore),
                outgoingAfter: Math.min(
                  99,
                  Math.max(
                    outgoingBefore + 1,
                    after.messages.filter(
                      (message) => message.direction === 'out',
                    ).length,
                  ),
                ),
                newOutgoing: true,
                observationMs: Date.now() - startedAt,
                lateError: 'none',
              },
            };
          }
          if (expired) break;
          await page.waitForTimeout(POLL_MS);
        }
      } catch {
        // Fall through: whatever happened, the message may have been sent.
        unconfirmed = 'observation_failed';
      }
      noteHot(
        hot,
        `send unconfirmed: ${unconfirmed}; network=${JSON.stringify(network.diagnostic())}`,
      );
      throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
    } catch (error) {
      if (phase === 'hot_thread') {
        const shape = await page
          .evaluate(() => ({
            logs: document.querySelectorAll('[role="log"]').length,
            messageIds: document.querySelectorAll(
              '[role="log"] [data-message-id]',
            ).length,
            editors: document.querySelectorAll('[data-lexical-editor]').length,
          }))
          .catch(() => ({ logs: 0, messageIds: 0, editors: 0 }));
        noteHot(
          hot,
          `hot_thread_failed ${JSON.stringify({ reason: shape.messageIds === 0 ? 'message_id_not_observed' : 'thread_unverified', ...shape, threadPathMatch: paths.includes(trimSlash(new URL(page.url()).pathname)) })}`,
        );
      }
      await capture();
      if (phase !== 'hot_confirmation')
        noteHot(
          hot,
          `send ${marked ? 'unconfirmed' : 'declined'}: ${phase}_failed`,
        );
      if (error instanceof SocialSendError) {
        error.reasonUk += ` ${JSON.stringify({ phase, network: network.diagnostic() })}`;
        throw error;
      }
      if (marked) {
        const failure = new SocialSendError(
          'delivery_uncertain',
          `Перевірте чат вручну. ${JSON.stringify({ phase, network: network.diagnostic() })}`,
        );
        throw failure;
      }
      // Before the dispatch an unexpected page state only means "not here".
      if (filled)
        await page
          .locator(EDITOR)
          .fill('')
          .catch(() => {});
      return null;
    } finally {
      network.stop();
      await baseline?.dispose().catch(() => {});
    }
  };
  return runOnHotPage(hot, send, 'send').finally(() => {
    hot.pendingSends--;
  });
}
