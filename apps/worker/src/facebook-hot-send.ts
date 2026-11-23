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
  // Cut a sweep's page load short instead of waiting for it to time out.
  if (hot.activeOps > 0)
    void hot.page.evaluate(() => window.stop()).catch(() => {});
  return runOnHotPage<FacebookDispatchResult | null>(hot, async (page) => {
    const { target, threadId, body, ownId, timeoutMs } = input;
    const operationStarted = Date.now();
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
        .waitFor({ state: 'visible', timeout: left() });
      const before = await readFacebookThread(page, ownId, 200);
      const first = before.messages[0];
      if (before.skipped.length)
        return decline(`read skipped ${before.skipped.slice(0, 2).join(',')}`);
      if (!first || first.threadId !== threadId)
        return decline('thread mismatch');
      if (
        before.messages.some(
          (message) =>
            socialTarget(message.peerProfile)?.handle !== target.handle,
        )
      )
        return decline('peer mismatch');
      const editor = page.locator(EDITOR);
      if ((await editor.count()) !== 1) return decline('composer count');
      if (normalize(await editor.innerText()) !== '')
        return decline('composer not empty');
      const known = new Set(before.messages.map((m) => m.externalMessageId));
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
      await page.keyboard.press('Enter');
      phase = 'hot_confirmation';
      let unconfirmed = 'new_outgoing_not_observed';
      try {
        for (;;) {
          const after = await readFacebookThread(page, ownId, 200);
          if (
            after.threadId !== threadId ||
            after.skipped.length ||
            after.messages.some(
              (message) =>
                socialTarget(message.peerProfile)?.handle !== target.handle,
            )
          ) {
            unconfirmed = 'conversation_unverified';
            break;
          }
          const added = after.messages.filter(
            (message) =>
              message.direction === 'out' &&
              !known.has(message.externalMessageId) &&
              normalize(message.body) === normalize(body),
          );
          if (added.length > 1) {
            unconfirmed = 'multiple_new_outgoing';
            break;
          }
          if (added.length === 1) {
            const externalMessageId = added[0]!.externalMessageId;
            const read = after.seenMessageId === externalMessageId;
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
                    readReceipt: { threadId, seenMessageId: externalMessageId },
                  }
                : {}),
              observation: {
                inputExactMatch: true,
                dispatchPerformed: true,
                outgoingBefore: Math.min(99, outgoingBefore),
                outgoingAfter: Math.min(
                  99,
                  after.messages.filter(
                    (message) => message.direction === 'out',
                  ).length,
                ),
                newOutgoing: true,
                observationMs: Date.now() - startedAt,
                lateError: 'none',
              },
            };
          }
          if (Date.now() - startedAt >= (input.confirmMs ?? CONFIRM_MS)) break;
          await page.waitForTimeout(POLL_MS);
        }
      } catch {
        // Fall through: whatever happened, the message may have been sent.
        unconfirmed = 'observation_failed';
      }
      noteHot(hot, `send unconfirmed: ${unconfirmed}`);
      throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
    } catch (error) {
      await capture();
      if (phase !== 'hot_confirmation')
        noteHot(
          hot,
          `send ${marked ? 'unconfirmed' : 'declined'}: ${phase}_failed`,
        );
      if (error instanceof SocialSendError) throw error;
      if (marked) {
        throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
      }
      // Before the dispatch an unexpected page state only means "not here".
      if (filled)
        await page
          .locator(EDITOR)
          .fill('')
          .catch(() => {});
      return null;
    }
  }).finally(() => {
    hot.pendingSends--;
  });
}
