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
    const decline = (why: string) => {
      noteHot(hot, `send declined: ${why}`);
      return null;
    };
    if (!/^\d+$/.test(threadId) || !body.trim()) return decline('input');
    const deadline = Date.now() + Math.min(timeoutMs, 20000);
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
            await link.first().click({ timeout: left() });
            await dismissRestore(page, deadline);
            await page.waitForURL(
              (url) => paths.includes(trimSlash(url.pathname)),
              { timeout: left() },
            );
            opened = true;
            break;
          }
        }
        if (!opened) return decline('chat not in list');
      }
      hot.primary = `${trimSlash(new URL(page.url()).pathname)}/`;
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
      await input.beforeSend();
      const startedAt = Date.now();
      // Exactly one dispatch; nothing below may press it again.
      await page.keyboard.press('Enter');
      try {
        for (;;) {
          const after = await readFacebookThread(page, ownId, 200);
          const added = after.messages.filter(
            (message) =>
              message.direction === 'out' &&
              !known.has(message.externalMessageId) &&
              normalize(message.body) === normalize(body),
          );
          if (added.length > 1) break;
          if (added.length === 1) {
            return {
              outcome: 'facebook_dispatched_unconfirmed',
              dialogUrl: target.canonicalUrl,
              threadId,
              externalMessageId: added[0]!.externalMessageId,
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
      }
      throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
    } catch (error) {
      if (error instanceof SocialSendError) throw error;
      if (marked)
        throw new SocialSendError('delivery_uncertain', 'Перевірте чат вручну');
      // Before the dispatch an unexpected page state only means "not here".
      noteHot(
        hot,
        `send error: ${error instanceof Error ? error.name : '?'} ${error instanceof Error ? error.message.slice(0, 60) : ''}`,
      );
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
