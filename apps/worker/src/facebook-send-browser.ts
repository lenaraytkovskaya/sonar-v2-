import type { Page } from 'playwright';
import type { SocialTarget } from '@sonar/core';
import { socialTarget } from '@sonar/core';
import {
  SocialSendError,
  SocialSessionCheckError,
  socialSessionCheckReason,
} from '@sonar/core/social-session';

type FinderBranch =
  | 'no_editor'
  | 'no_region'
  | 'multiple'
  | 'forbidden'
  | 'name_mismatch'
  | 'composer_scope'
  | 'header_count'
  | 'parent_structure'
  | 'recipient_link_count'
  | 'wrong_recipient'
  | 'bound'
  | 'invalidated'
  | 'dispatch_blocked'
  | 'unconfirmed'
  | 'baseline_invalidated'
  | 'draft';
type Counts = {
  raw: number;
  visible: number;
  visibility: 'absent' | 'visible' | 'inert' | 'hidden' | 'display';
};
type Observation = {
  branch: FinderBranch;
  pageKind: 'profile' | 'direct' | 'other' | 'login';
  editors: Counts;
  regions: Counts;
  links?: Counts;
  buttons?: Counts;
  headers: number;
  recipientLinks: number;
  candidates: number;
  hasRecipientLink: boolean;
  canonicalMatch: boolean;
  nameMatch: boolean;
};

// English labels and Lexical attributes observed by root in Facebook's floating
// chat. No message-row roles or DOM IDs are assumed.
async function conversation(
  page: Page,
  recipient: string,
  body: string,
  observe: (observation: Observation) => void,
) {
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
      const composerContainer = '[aria-label="Thread composer"]';
      const branch = (scope: Element, node: Element) => {
        while (node.parentElement && node.parentElement !== scope)
          node = node.parentElement;
        return node.parentElement === scope ? node : null;
      };
      const headerControls = (header: Element) => {
        const labels = all(header, 'button, [role="button"]').map((node) =>
          normalize(node.getAttribute('aria-label') || node.textContent),
        );
        return (
          labels.includes('Chat settings') ||
          (labels.includes('Minimise chat') && labels.includes('Close chat'))
        );
      };
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
      const namesRecipient = (link: Element, name: string) => {
        const text = normalize(link.textContent);
        const label = normalize(link.getAttribute('aria-label'));
        // The live avatar link has no text; its exact accessible name binds it
        // to the composer/log name. Reject contradictory labels or text.
        return (label || text) === name && (!text || text === name);
      };
      const headersIn = (scope: Element, region: Element, composer: Element) =>
        Array.from(scope.children).filter(
          (child) =>
            child !== branch(scope, region) &&
            child !== branch(scope, composer) &&
            headerControls(child),
        );
      const count = (value: number) => Math.min(value, 9);
      const measure = (scope: ParentNode, selector: string): Counts => {
        const raw = Array.from(scope.querySelectorAll(selector));
        const node = raw.find(visible) ?? raw[0];
        return {
          raw: count(raw.length),
          visible: count(raw.filter(visible).length),
          visibility: !node
            ? 'absent'
            : visible(node)
              ? 'visible'
              : node.closest('[inert]')
                ? 'inert'
                : node.closest('[hidden], [aria-hidden="true"]') ||
                    getComputedStyle(node).visibility !== 'visible'
                  ? 'hidden'
                  : 'display',
        };
      };
      const pageKind = (): Observation['pageKind'] =>
        /^\/(?:login|checkpoint)(?:[/.]|$)/.test(location.pathname)
          ? 'login'
          : /^\/messages(?:\/|$)/.test(location.pathname)
            ? 'direct'
            : location.pathname === '/profile.php' ||
                /^\/[\w.-]+\/?$/.test(location.pathname)
              ? 'profile'
              : 'other';
      let observation: Observation;
      const find = () => {
        observation = {
          branch: 'no_editor',
          pageKind: pageKind(),
          editors: measure(document, composerSelector),
          regions: measure(document, regionSelector),
          headers: 0,
          recipientLinks: 0,
          candidates: 0,
          hasRecipientLink: false,
          canonicalMatch: false,
          nameMatch: false,
        };
        const reject = (branch: FinderBranch) => {
          observation.branch = branch;
        };
        const candidates = [];
        const initial = observation;
        for (const editor of all(document, composerSelector)) {
          observation = { ...initial, branch: 'no_region' };
          if (editor.closest(forbidden)) {
            reject('forbidden');
            continue;
          }
          for (
            let scope = editor.parentElement;
            scope && scope !== document.body;
            scope = scope.parentElement
          ) {
            const regions = all(scope, regionSelector);
            if (!regions.length) continue;
            observation.regions = measure(scope, regionSelector);
            observation.editors = measure(scope, composerSelector);
            // Never absorb page navigation or a neighbouring conversation.
            if (
              regions.length !== 1 ||
              all(scope, composerSelector).length !== 1 ||
              all(scope, forbidden).length
            ) {
              reject(all(scope, forbidden).length ? 'forbidden' : 'multiple');
              break;
            }
            const region = regions[0]!;
            const name = normalize(
              editor.getAttribute('aria-label')?.slice('Write to '.length) ??
                '',
            );
            if (
              !name ||
              normalize(region.getAttribute('aria-label')) !==
                `Messages in conversation with ${name}`
            ) {
              reject('name_mismatch');
              break;
            }
            const composer = editor.closest(composerContainer);
            if (!composer || !scope.contains(composer)) {
              reject('composer_scope');
              break;
            }
            const contentScope = scope;
            let headers = headersIn(scope, region, composer);
            if (!headers.length) {
              // Support the observed header/body split when the nearest shared
              // messages/composer container is the body rather than the chat root.
              // Allow only that immediate two-branch parent, never an ancestor
              // search that could borrow a profile-page link outside this chat.
              const parent = scope.parentElement;
              if (
                headerControls(contentScope) ||
                !parent ||
                parent === document.body ||
                all(parent, ':scope > *').length !== 2 ||
                all(parent, regionSelector).length !== 1 ||
                all(parent, composerSelector).length !== 1 ||
                all(parent, forbidden).length
              ) {
                reject('parent_structure');
                break;
              }
              scope = parent;
              headers = headersIn(scope, region, composer);
            }
            observation.headers = count(headers.length);
            if (headers.length !== 1) {
              reject('header_count');
              break;
            }
            const header = headers[0]!;
            const links = all(header, 'a[href]');
            const recipientLinks = links.filter(
              (link) =>
                identity(link) === recipient && namesRecipient(link, name),
            );
            observation.links = measure(header, 'a[href]');
            observation.recipientLinks = count(recipientLinks.length);
            observation.hasRecipientLink = links.length > 0;
            observation.canonicalMatch = links.some(
              (link) => identity(link) === recipient,
            );
            observation.nameMatch = links.some((link) =>
              namesRecipient(link, name),
            );
            if (
              recipientLinks.length !== 1 ||
              links.some(
                (link) => identity(link) && identity(link) !== recipient,
              )
            ) {
              reject(
                links.some(
                  (link) => identity(link) && identity(link) !== recipient,
                )
                  ? 'wrong_recipient'
                  : 'recipient_link_count',
              );
              break;
            }
            candidates.push({
              observation: { ...observation },
              scope,
              contentScope,
              region,
              composer,
              header,
              editor,
              link: recipientLinks[0]!,
              name,
            });
            break;
          }
        }
        observation.candidates = count(candidates.length);
        if (candidates.length !== 1) {
          if (candidates.length > 1) observation.branch = 'multiple';
          return null;
        }
        observation = {
          ...candidates[0]!.observation,
          candidates: 1,
          branch: 'bound',
        };
        const {
          scope,
          contentScope,
          region,
          composer,
          header,
          editor,
          link,
          name,
        } = candidates[0]!;
        const sendSelector =
          '[role="button"][aria-label="Press Enter to send"], button[aria-label="Press Enter to send"]';
        const sendButtons = () => all(composer, sendSelector);
        const pinned = [
          scope,
          contentScope,
          region,
          composer,
          header,
          editor,
          link,
        ];
        const parents = pinned.map((node) => node.parentElement);
        const valid = (filled: boolean) =>
          pinned.every(
            (node, index) => node.parentElement === parents[index],
          ) &&
          contentScope.contains(region) &&
          contentScope.contains(composer) &&
          (contentScope === scope ||
            (contentScope.parentElement === scope &&
              all(scope, ':scope > *').length === 2 &&
              !headerControls(contentScope))) &&
          header.parentElement === scope &&
          headerControls(header) &&
          header.contains(link) &&
          all(header, 'a[href]').filter(
            (anchor) => identity(anchor) === recipient,
          ).length === 1 &&
          !all(header, 'a[href]').some(
            (anchor) => identity(anchor) && identity(anchor) !== recipient,
          ) &&
          !header.contains(region) &&
          !header.contains(composer) &&
          composer.contains(editor) &&
          editor.closest(composerContainer) === composer &&
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
          namesRecipient(link, name) &&
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
        const verify = (filled: boolean) => {
          const ok = valid(filled);
          if (!ok) {
            observation.branch = 'invalidated';
            observation.editors = measure(scope, composerSelector);
            observation.regions = measure(scope, regionSelector);
            observation.links = measure(header, 'a[href]');
            observation.buttons = measure(composer, sendSelector);
            const links = all(header, 'a[href]');
            observation.pageKind = pageKind();
            observation.headers = count(
              headersIn(scope, region, composer).length,
            );
            observation.recipientLinks = count(
              links.filter(
                (link) =>
                  identity(link) === recipient && namesRecipient(link, name),
              ).length,
            );
            observation.hasRecipientLink = links.length > 0;
            observation.canonicalMatch = links.some(
              (link) => identity(link) === recipient,
            );
            observation.nameMatch = links.some((link) =>
              namesRecipient(link, name),
            );
          }
          return ok;
        };
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
          // Exclude only the actual body subtree, never its labelled row.
          // Inspect direct visible text and labels to catch nested status siblings
          // without interpreting a message such as "Sending" as delivery status.
          const bodies = all(row, '*').filter(
            (node) =>
              normalize(node.textContent) === normalize(body) &&
              normalize(node.parentElement?.textContent ?? '') !==
                normalize(body) &&
              !node.closest('h2, [role="heading"]'),
          );
          if (bodies.length !== 1) return null;
          const messageBody = bodies[0]!;
          if (
            all(wrapper, '[aria-busy="true"], [role="progressbar"]').length ||
            [wrapper, ...all(wrapper, '*')].some((node) => {
              const inBody = messageBody.contains(node);
              if (buttons[0]!.contains(node)) return false;
              const text = Array.from(node.childNodes)
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => child.textContent)
                .join(' ');
              const label =
                node === row ||
                (node === messageBody &&
                  normalize(node.getAttribute('aria-label')) ===
                    normalize(body))
                  ? ''
                  : node.getAttribute('aria-label');
              return /\b(?:sending|pending|failed|not sent|retry|couldn.t send)\b/i.test(
                [
                  inBody && node.getAttribute('role') !== 'status' ? '' : text,
                  label,
                ].join(' '),
              );
            })
          )
            return null;
          return JSON.stringify([
            row.getAttribute('aria-label'),
            buttons[0]!.getAttribute('aria-label'),
          ]);
        };
        let baseline: Element[] = [];
        let signatures: (string | null)[] = [];
        let blocked = false;
        let cleanup = () => {};
        const guardDispatch = (button: Element) => {
          const parent = button.parentElement;
          const guard = (event: Event) => {
            const onButton = event.composedPath().includes(button);
            if (event.currentTarget === window && !onButton) return;
            blocked ||=
              !onButton ||
              !verify(true) ||
              sendButtons()[0] !== button ||
              button.parentElement !== parent ||
              !visible(button) ||
              button.matches(':disabled') ||
              Boolean(button.closest('[aria-disabled="true"], [inert]')) ||
              (event instanceof MouseEvent &&
                !button.contains(
                  document.elementFromPoint(event.clientX, event.clientY),
                ));
            if (blocked) {
              if (observation.branch !== 'invalidated')
                observation.branch = 'dispatch_blocked';
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          };
          const events = [
            'pointerdown',
            'mousedown',
            'pointerup',
            'mouseup',
            'click',
          ];
          // As in IG, capture at the chat boundary runs after document capture.
          // This guards UI consistency, not arbitrary changes in final handlers.
          for (const boundary of [window, scope, button])
            for (const event of events)
              boundary.addEventListener(event, guard, {
                capture: true,
                passive: false,
              });
          cleanup = () => {
            for (const boundary of [window, scope, button])
              for (const event of events)
                boundary.removeEventListener(event, guard, true);
          };
        };
        return {
          diagnostic: () => observation,
          guardDispatch,
          blocked: () => blocked,
          cleanup: () => cleanup(),
          editor,
          scope,
          region,
          valid: verify,
          empty: () => {
            const empty = !normalize((editor as HTMLElement).innerText);
            if (!empty) observation.branch = 'draft';
            return empty;
          },
          button: () => sendButtons()[0]!,
          arm: () => {
            baseline = rows();
            signatures = baseline.map(sentRow);
          },
          confirmed: () => {
            if (!verify(false)) return false;
            if (
              baseline.some((row) => !row.isConnected || !region.contains(row))
            ) {
              observation.branch = 'baseline_invalidated';
              return false;
            }
            observation.branch = 'unconfirmed';
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
      return { find, diagnostic: () => observation };
    },
    { recipient, body },
  );
  try {
    await page.waitForFunction((finder) => finder.find() !== null, finder);
    const state = await finder.evaluateHandle((finder) => finder.find());
    observe(await finder.evaluate((finder) => finder.diagnostic()));
    return state;
  } catch (error) {
    // Read the stored last poll, never a fresh scan of a later DOM.
    const observation = await finder
      .evaluate((finder) => finder.diagnostic())
      .catch(() => undefined);
    if (observation) observe(observation);
    throw error;
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
  let observation: Observation | undefined;
  let branch = 'not_observed';
  const observe = (value: Observation) => {
    observation = value;
  };
  const diagnostic = (error: unknown) =>
    JSON.stringify({
      version: 'fb-observed84-v1',
      phase,
      ...observation,
      branch:
        branch === 'not_observed' ? (observation?.branch ?? branch) : branch,
      failure:
        error instanceof SocialSendError &&
        !(error instanceof SocialSessionCheckError)
          ? 'not_found'
          : socialSessionCheckReason(error, 'browser') === 'timeout'
            ? 'timeout'
            : 'unknown',
    });
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
    try {
      await assertSession();
    } catch (error) {
      // Missing auth chrome is not evidence that cookies expired (e.g. an error
      // document or failed navigation). Only observed login/challenge UI pauses.
      if (
        error instanceof SocialSessionCheckError &&
        error.reason === 'unknown_auth'
      )
        throw unavailable('session_check');
      throw error;
    }
  };
  const unavailable = (
    reason?:
      | 'http_error'
      | 'profile_mismatch'
      | 'action_count'
      | 'session_check'
      | 'url_changed'
      | 'button_changed',
  ) => {
    if (reason) branch = reason;
    return new SocialSendError(
      'unavailable',
      `[facebook/${phase}] Не підтверджено одержувача активного діалогу, поле або кнопку повідомлення Facebook.`,
    );
  };
  try {
    const response = await page
      .goto(target.canonicalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      })
      .catch((error: unknown) => {
        throw new SocialSessionCheckError(
          socialSessionCheckReason(error, 'network') === 'timeout'
            ? 'timeout'
            : 'network',
        );
      });
    if (response?.status() === 429)
      throw new SocialSessionCheckError('rate_limit');
    if (response && (response.status() === 407 || response.status() >= 500))
      throw new SocialSessionCheckError('network');
    await check();
    if (response && response.status() >= 400) throw unavailable('http_error');
    phase = 'profile';
    if (socialTarget(page.url())?.handle !== target.handle)
      throw unavailable('profile_mismatch');
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
    if ((await actions.count()) !== 1) throw unavailable('action_count');
    await actions.click();
    await check();
    phase = 'first_lookup';
    let state = await conversation(page, target.handle, body, observe);
    try {
      if (
        !(await state.evaluate((state) => state?.valid(false) && state.empty()))
      )
        throw unavailable();
      const editor = (
        await state.evaluateHandle((state) => state!.editor)
      ).asElement();
      if (!editor) throw unavailable();
      phase = 'after_fill';
      await editor.fill(body);
      // Lexical may rerender during fill. Rebind only before the durable marker.
      await state.dispose();
      state = await conversation(page, target.handle, body, observe);
      if (!(await state.evaluate((state) => state?.valid(true))))
        throw unavailable();
      const dialogUrl = page.url();
      const button = (
        await state.evaluateHandle((state) => state!.button())
      ).asElement();
      if (!button) throw unavailable();
      phase = 'before_marker';
      await check();
      attempted = true; // A callback error may follow a committed durable write.
      phase = 'after_marker';
      await beforeSend();
      await check();
      if (page.url() !== dialogUrl) throw unavailable('url_changed');
      if (!(await state.evaluate((state) => state?.valid(true))))
        throw unavailable();
      if (
        !(await button.evaluate(
          (button, state) =>
            button === state!.button() && !button.matches(':disabled'),
          state,
        ))
      )
        throw unavailable('button_changed');
      if (
        !(await state.evaluate((state, button) => {
          if (!state?.valid(true) || state.button() !== button) return false;
          state.arm();
          state.guardDispatch(button);
          return true;
        }, button))
      )
        throw unavailable();
      phase = 'dispatch';
      await button.click(); // Exactly one dispatch, never retry after the marker.
      if (await state.evaluate((state) => state!.blocked()))
        throw unavailable();
      phase = 'confirmation';
      await page.waitForFunction((state) => state?.confirmed(), state, {
        timeout: timeoutMs,
      });
      await check();
      if (page.url() !== dialogUrl) throw unavailable('url_changed');
      if (!(await state.evaluate((state) => state?.confirmed())))
        throw unavailable();
      // Floating chats have no thread URL. Return the verified recipient's stable
      // profile URL; do not fabricate a /messages/t/ thread identifier.
      return target.canonicalUrl;
    } catch (error) {
      // Only retrieve memory captured by the failing check/dispatch/last poll.
      const last = await state
        .evaluate((state) => state?.diagnostic())
        .catch(() => undefined);
      if (last) observe(last);
      throw error;
    } finally {
      await state.evaluate((state) => state?.cleanup()).catch(() => {});
      await state.dispose();
    }
  } catch (error) {
    // Explicit auth/checkpoint/rate-limit evidence pauses the account. A closed
    // page or failed recheck must still be uncertain after the durable marker.
    const detail = diagnostic(error);
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
    ) {
      caught.reasonUk += ` ${detail}`;
      throw caught;
    }
    if (attempted)
      throw new SocialSendError(
        'delivery_uncertain',
        `[facebook/${phase}] Доставку не підтверджено. Перевірте чат вручну; не повторюйте надсилання автоматично. ${detail}`,
      );
    if (caught instanceof SocialSendError && caught.code === 'unavailable') {
      caught.reasonUk += ` ${detail}`;
      throw caught;
    }
    const failure = unavailable();
    failure.reasonUk += ` ${detail}`;
    throw failure;
  }
}
