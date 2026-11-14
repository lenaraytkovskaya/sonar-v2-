import type { Page } from 'playwright';
import type { SocialTarget } from '@sonar/core';
import { socialTarget } from '@sonar/core';
import {
  SocialSendError,
  SocialSessionCheckError,
} from '@sonar/core/social-session';

// English labels and Lexical attributes observed by root in Facebook's floating
// chat. No message-row roles or DOM IDs are assumed.
async function conversation(page: Page, recipient: string, body: string) {
  const finder = await page.evaluateHandle(
    ({ recipient, body }) => {
      const normalize = (text: string | null) =>
        (text ?? '').replace(/\s+/g, ' ').trim();
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === 'visible' &&
        !node.closest('[hidden], [aria-hidden="true"], [inert]');
      const all = (node: ParentNode, selector: string) =>
        Array.from(node.querySelectorAll(selector)).filter(visible);
      const regionSelector = '[aria-label^="Messages in conversation with "]';
      const composerSelector =
        '[contenteditable="true"][role="textbox"][data-lexical-editor="true"][aria-label^="Write to "]';
      const forbidden =
        'nav, [role="navigation"], aside, [role="complementary"]';
      const identity = (anchor: Element) => {
        try {
          const url = new URL(anchor.getAttribute('href')!, location.href);
          if (
            url.protocol !== 'https:' ||
            !/^(www\.)?facebook\.com$/.test(url.hostname) ||
            url.username ||
            url.password
          )
            return null;
          return url.pathname === '/profile.php'
            ? url.searchParams.get('id')
            : /^\/([\w.-]+)\/?$/.exec(url.pathname)?.[1]?.toLowerCase();
        } catch {
          return null;
        }
      };
      return () => {
        const candidates = [];
        for (const editor of all(document, composerSelector)) {
          if (editor.closest(forbidden)) continue;
          for (
            let scope = editor.parentElement;
            scope && scope !== document.body;
            scope = scope.parentElement
          ) {
            const regions = all(scope, regionSelector);
            if (!regions.length) continue;
            // Never absorb page navigation or a neighbouring conversation.
            if (
              regions.length !== 1 ||
              all(scope, composerSelector).length !== 1 ||
              all(scope, forbidden).length
            )
              break;
            const region = regions[0]!;
            const name = normalize(
              editor.getAttribute('aria-label')?.slice('Write to '.length) ??
                '',
            );
            if (
              !name ||
              normalize(region.getAttribute('aria-label')) !==
                `Messages in conversation with ${name}`
            )
              break;
            const links = all(scope, 'a[href]').filter(
              (link) => !region.contains(link) && !editor.contains(link),
            );
            const recipientLinks = links.filter(
              (link) =>
                identity(link) === recipient &&
                normalize(link.textContent) === name,
            );
            if (!recipientLinks.length) continue;
            if (
              recipientLinks.length !== 1 ||
              links.some(
                (link) => identity(link) && identity(link) !== recipient,
              )
            )
              break;
            candidates.push({
              scope,
              region,
              editor,
              link: recipientLinks[0]!,
              name,
            });
            break;
          }
        }
        if (candidates.length !== 1) return null;
        const { scope, region, editor, link, name } = candidates[0]!;
        const sendButtons = () =>
          all(
            scope,
            '[role="button"][aria-label="Press Enter to send"], button[aria-label="Press Enter to send"]',
          );
        const valid = (filled: boolean) =>
          scope.isConnected &&
          region.isConnected &&
          editor.isConnected &&
          link.isConnected &&
          visible(scope) &&
          visible(region) &&
          visible(editor) &&
          visible(link) &&
          scope.contains(region) &&
          scope.contains(editor) &&
          scope.contains(link) &&
          !region.contains(link) &&
          !editor.contains(link) &&
          !scope.closest(forbidden) &&
          identity(link) === recipient &&
          normalize(link.textContent) === name &&
          editor.getAttribute('aria-label') === `Write to ${name}` &&
          region.getAttribute('aria-label') ===
            `Messages in conversation with ${name}` &&
          all(scope, composerSelector).length === 1 &&
          all(scope, composerSelector)[0] === editor &&
          all(scope, regionSelector).length === 1 &&
          all(scope, regionSelector)[0] === region &&
          !all(scope, forbidden).length &&
          (!filled ||
            ((editor as HTMLElement).isContentEditable &&
              normalize((editor as HTMLElement).innerText) ===
                normalize(body) &&
              editor.getAttribute('aria-disabled') !== 'true' &&
              editor.getAttribute('aria-readonly') !== 'true' &&
              sendButtons().length === 1 &&
              sendButtons()[0]!.getAttribute('aria-disabled') !== 'true'));
        const rows = () =>
          all(region, '[aria-label]').filter(
            (row) =>
              /^At .+, You: /s.test(row.getAttribute('aria-label') ?? '') &&
              all(row, 'h2, [role="heading"][aria-level="2"]').some(
                (heading) => normalize(heading.textContent) === 'You sent',
              ),
          );
        const sentRow = (row: Element) => {
          // The observed sent button is a sibling of the labelled content container.
          // Do not infer delivery from a disappearing editor, alignment or text alone.
          let wrapper = row.parentElement;
          while (
            wrapper &&
            wrapper !== region &&
            !all(wrapper, '[role="button"], button').length
          )
            wrapper = wrapper.parentElement;
          if (
            !wrapper ||
            wrapper === region ||
            rows().filter((other) => wrapper!.contains(other)).length !== 1
          )
            return null;
          const buttons = all(
            wrapper,
            '[role="button"][aria-label], button[aria-label]',
          ).filter((button) =>
            /^Enter, Message sent .+ by You: /s.test(
              button.getAttribute('aria-label') ?? '',
            ),
          );
          if (
            buttons.length !== 1 ||
            !normalize(row.getAttribute('aria-label')).endsWith(
              `, You: ${normalize(body)}`,
            ) ||
            !normalize(buttons[0]!.getAttribute('aria-label')).endsWith(
              ` by You: ${normalize(body)}`,
            ) ||
            !all(row, '*').some(
              (node) => normalize(node.textContent) === normalize(body),
            )
          )
            return null;
          if (
            all(wrapper, '[aria-busy="true"], [role="progressbar"]').length ||
            all(wrapper, '*')
              .filter(
                (node) =>
                  !row.contains(node) &&
                  node !== buttons[0] &&
                  !buttons[0]!.contains(node),
              )
              .some((node) =>
                /\b(?:sending|pending|failed|not sent|retry|couldn.t send)\b/i.test(
                  [node.textContent, node.getAttribute('aria-label')].join(' '),
                ),
              )
          )
            return null;
          return JSON.stringify([
            row.getAttribute('aria-label'),
            buttons[0]!.getAttribute('aria-label'),
          ]);
        };
        let baseline: Element[] = [];
        let signatures: (string | null)[] = [];
        return {
          editor,
          scope,
          region,
          valid,
          empty: () => !normalize((editor as HTMLElement).innerText),
          button: () => sendButtons()[0]!,
          arm: () => {
            baseline = rows();
            signatures = baseline.map(sentRow);
          },
          confirmed: () => {
            if (
              !valid(false) ||
              baseline.some((row) => !row.isConnected || !region.contains(row))
            )
              return false;
            const current = rows();
            return current.some((row) => {
              const signature = sentRow(row);
              return (
                !baseline.includes(row) &&
                signature !== null &&
                current.filter((other) => sentRow(other) === signature).length >
                  signatures.filter((old) => old === signature).length
              );
            });
          },
        };
      };
    },
    { recipient, body },
  );
  try {
    await page.waitForFunction((find) => find() !== null, finder);
    return await finder.evaluateHandle((find) => find());
  } finally {
    await finder.dispose();
  }
}

export async function sendFacebook(
  page: Page,
  target: SocialTarget,
  timeoutMs: number,
  body: string,
  beforeSend: () => Promise<void>,
  assertSession: () => Promise<void>,
) {
  let attempted = false;
  let phase = 'navigation';
  let restricted = false;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      /^(www\.)?facebook\.com$/.test(url.hostname) &&
      response.status() === 429 &&
      ['document', 'xhr', 'fetch'].includes(response.request().resourceType())
    )
      restricted = true;
  });
  const check = async () => {
    if (restricted) throw new SocialSessionCheckError('rate_limit');
    await assertSession();
  };
  const unavailable = () =>
    new SocialSendError(
      'unavailable',
      `[facebook/${phase}] Не підтверджено одержувача активного діалогу, поле або кнопку повідомлення Facebook.`,
    );
  try {
    const response = await page.goto(target.canonicalUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    if (response?.status() === 429)
      throw new SocialSessionCheckError('rate_limit');
    await check();
    if (response && response.status() >= 400) throw unavailable();
    phase = 'profile';
    if (socialTarget(page.url())?.handle !== target.handle) throw unavailable();
    const actions = page
      .locator('main, [role="main"]')
      .getByRole('button', {
        name: /^(?:Message|Send message|Повідомлення|Надіслати повідомлення|Сообщение|Отправить сообщение)$/i,
      })
      .or(
        page.locator('main, [role="main"]').getByRole('link', {
          name: /^(?:Message|Send message|Повідомлення|Надіслати повідомлення|Сообщение|Отправить сообщение)$/i,
        }),
      )
      .filter({ visible: true });
    await actions.waitFor({ state: 'visible' });
    if ((await actions.count()) !== 1) throw unavailable();
    await actions.click();
    await check();
    phase = 'dialog';
    let state = await conversation(page, target.handle, body);
    try {
      if (
        !(await state.evaluate((state) => state?.valid(false) && state.empty()))
      )
        throw unavailable();
      const editor = (
        await state.evaluateHandle((state) => state!.editor)
      ).asElement();
      if (!editor) throw unavailable();
      phase = 'composer';
      await editor.fill(body);
      // Lexical may rerender during fill. Rebind only before the durable marker.
      await state.dispose();
      state = await conversation(page, target.handle, body);
      if (!(await state.evaluate((state) => state?.valid(true))))
        throw unavailable();
      const dialogUrl = page.url();
      const button = (
        await state.evaluateHandle((state) => state!.button())
      ).asElement();
      if (!button) throw unavailable();
      await check();
      phase = 'attempt';
      attempted = true; // A callback error may follow a committed durable write.
      await beforeSend();
      await check();
      if (
        page.url() !== dialogUrl ||
        !(await state.evaluate((state) => state?.valid(true))) ||
        !(await button.evaluate(
          (button, state) =>
            button === state!.button() && !button.matches(':disabled'),
          state,
        ))
      )
        throw unavailable();
      await state.evaluate((state) => state!.arm());
      phase = 'confirmation';
      await button.click(); // Exactly one dispatch, never retry after the marker.
      await page.waitForFunction((state) => state?.confirmed(), state, {
        timeout: timeoutMs,
      });
      await check();
      if (
        page.url() !== dialogUrl ||
        !(await state.evaluate((state) => state?.confirmed()))
      )
        throw unavailable();
      // Floating chats have no thread URL. Return the verified recipient's stable
      // profile URL; do not fabricate a /messages/t/ thread identifier.
      return target.canonicalUrl;
    } finally {
      await state.dispose();
    }
  } catch (error) {
    // Explicit auth/checkpoint/rate-limit evidence pauses the account. A closed
    // page or failed recheck must still be uncertain after the durable marker.
    let caught = error;
    try {
      await check();
    } catch (sessionError) {
      if (
        sessionError instanceof SocialSendError &&
        ['session_invalid', 'rate_limit'].includes(sessionError.code)
      )
        caught = sessionError;
    }
    if (
      caught instanceof SocialSendError &&
      ['session_invalid', 'rate_limit'].includes(caught.code)
    )
      throw caught;
    if (attempted)
      throw new SocialSendError(
        'delivery_uncertain',
        `[facebook/${phase}] Доставку не підтверджено. Перевірте чат вручну; не повторюйте надсилання автоматично.`,
      );
    throw unavailable();
  }
}
