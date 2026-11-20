import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { navigateSocialPage } from './social-navigation.js';
import type { SocialTarget } from '@sonar/core';
import { socialTarget } from '@sonar/core';
import {
  SocialSendError,
  type FacebookDispatchResult,
  type SocialComposerDraft,
  SocialSessionCheckError,
  socialSessionCheckReason,
} from '@sonar/core/social-session';

type FinderBranch =
  | 'no_editor'
  | 'no_region'
  | 'multiple'
  | 'forbidden'
  | 'name_mismatch'
  | 'history_loading'
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
type ParentStructureReason =
  | 'content_controls'
  | 'parent_missing'
  | 'parent_body'
  | 'parent_competing'
  | 'parent_regions'
  | 'parent_editors'
  | 'parent_forbidden';
type ParentStructureCounts = {
  childrenVisible?: number;
  regionsVisible?: number;
  editorsVisible?: number;
  forbiddenVisible?: number;
  actionsOutside?: number;
  extraEditors?: number;
  extraComposers?: number;
  linksOutside?: number;
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
  parentStructure?: ParentStructureCounts & {
    subreason: ParentStructureReason;
  };
};

// English labels and Lexical attributes observed by root in Facebook's floating
// chat. No message-row roles or DOM IDs are assumed.
async function conversation(
  page: Page,
  recipient: string,
  body: string,
  observe: (observation: Observation) => void,
  timeoutMs: number,
  openedProfile?: { url: string; name: string },
) {
  const finder = await page.evaluateHandle(
    ({ recipient, body, openedProfile }) => {
      const normalize = (text: string | null) =>
        (text ?? '').replace(/\s+/g, ' ').trim();
      // Recipient names tolerate formatting controls and case; draft text does not.
      const normalizeName = (text: string | null) =>
        normalize(
          (text ?? '').replace(
            /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\ufe0e|\ufe0f/g,
            '',
          ),
        ).toLowerCase();
      const headerName = (text: string | null) =>
        normalizeName(text)
          .replace(/(?:\s*[⌄▾▼∨˅›❯⌃▴▲‹❮〉〈>])+$/u, '')
          .trim();
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === 'visible' &&
        !node.closest('[hidden], [aria-hidden="true"], [inert]');
      const all = (node: ParentNode, selector: string) =>
        Array.from(node.querySelectorAll(selector)).filter(visible);
      const historyLoading = (scope: Element) =>
        [scope, ...all(scope, '*')].some(
          (node) =>
            node.getAttribute('role') === 'progressbar' ||
            node.getAttribute('aria-busy') === 'true' ||
            /^(?:loading|завантаження|загрузка)(?:[ .…]|$)/i.test(
              normalize(node.getAttribute('aria-label')),
            ),
        );
      const namedLabel = (node: Element, pattern: RegExp) => {
        const label = normalize(node.getAttribute('aria-label'));
        return label ? normalizeName(pattern.exec(label)?.[1] ?? '') : null;
      };
      const editorPattern = /^(?:write to|напишіть|напишите)\s+(.+)$/i;
      const regionPattern =
        /^(?:messages in conversation with|повідомлення в розмові з|сообщения в переписке с)\s+(.+)$/i;
      const regionSelector =
        '[aria-label^="Messages in conversation with "], [aria-label^="Повідомлення в розмові з "], [aria-label^="Сообщения в переписке с "], [role="log"]';
      const composerSelector =
        '[contenteditable="true"][role="textbox"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"][aria-placeholder="Aa"]';
      const composerContainers =
        '[aria-label="Thread composer"], [aria-label="Засіб створення повідомлення"], [aria-label="Область створення повідомлення"], [aria-label="Область ввода сообщения"]';
      const composerContainer = composerContainers;
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
          labels.some((label) =>
            /^(?:chat settings|налаштування чату|настройки чата)$/i.test(label),
          ) ||
          (labels.some((label) =>
            /^(?:minimise chat|minimize chat|згорнути чат|свернуть чат)$/i.test(
              label,
            ),
          ) &&
            labels.some((label) =>
              /^(?:close chat|закрити чат|закрыть чат)$/i.test(label),
            ))
        );
      };
      const chatControls = (scope: Element) =>
        all(scope, 'button, [role="button"]').filter((node) =>
          /^(?:chat settings|налаштування чату|настройки чата|minimise chat|minimize chat|згорнути чат|свернуть чат|close chat|закрити чат|закрыть чат|start a voice call|почати голосовий виклик|начать голосовой вызов|start a video call|почати відеодзвінок|начать видеозвонок)$/i.test(
            normalize(node.getAttribute('aria-label') || node.textContent),
          ),
        );
      const forbidden =
        'nav, [role="navigation"], aside, [role="complementary"]';
      const identityUrl = (href: string) => {
        try {
          const url = new URL(href, location.href);
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
      const identity = (anchor: Element) =>
        identityUrl(anchor.getAttribute('href')!);
      const namesRecipient = (
        link: Element,
        name: string,
        allowEmpty = false,
      ) => {
        const text = normalizeName(link.textContent);
        const label = normalizeName(link.getAttribute('aria-label'));
        // The live avatar link has no text; its exact accessible name binds it
        // to the composer/log name. Reject contradictory labels or text.
        return (
          ((allowEmpty && !label && !text) || (label || text) === name) &&
          (!text || text === name)
        );
      };
      const profileHeaderNames = (header: Element, name: string) => {
        const textName = (node: Element) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text = '';
          while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;
            if (
              parent &&
              visible(parent) &&
              !parent.closest('svg, img, [role="img"], [aria-hidden="true"]')
            )
              text += walker.currentNode.textContent;
          }
          return headerName(text);
        };
        const matches = all(
          header,
          'button, [role="button"], a[href], span',
        ).filter(
          (node) =>
            textName(node) === name &&
            (!node.getAttribute('aria-label') ||
              headerName(node.getAttribute('aria-label')) === name) &&
            (() => {
              for (
                let parent = node.parentElement;
                parent && parent !== header;
                parent = parent.parentElement
              )
                if (
                  parent.hasAttribute('aria-label') &&
                  headerName(parent.getAttribute('aria-label')) !== name
                )
                  return false;
              return true;
            })(),
        );
        return matches.filter(
          (node) =>
            !matches.some((other) => other !== node && other.contains(node)),
        );
      };
      const profileBindingValid = (header: Element, name: string) =>
        Boolean(
          openedProfile &&
          location.href === openedProfile.url &&
          pageKind() === 'profile' &&
          identityUrl(location.href) === recipient &&
          name === normalizeName(openedProfile.name) &&
          all(document, 'main h1, [role="main"] h1').length === 1 &&
          normalizeName(
            all(document, 'main h1, [role="main"] h1')[0]!.textContent,
          ) === name &&
          all(document, composerSelector).length === 1 &&
          all(document, regionSelector).length === 1 &&
          headerControls(header) &&
          chatControls(document.documentElement).every((node) =>
            header.contains(node),
          ) &&
          all(header, 'a[href]').every(
            (link) =>
              !identity(link) ||
              (identity(link) === recipient &&
                namesRecipient(link, name, true)),
          ) &&
          profileHeaderNames(header, name).length === 1,
        );
      const headersIn = (scope: Element, region: Element, composer: Element) =>
        Array.from(scope.children).filter(
          (child) =>
            child !== branch(scope, region) &&
            child !== branch(scope, composer) &&
            (headerControls(child) ||
              (all(child, 'button, [role="button"]').length > 0 &&
                all(child, 'a[href]').some(
                  (link) => identity(link) === recipient,
                ))),
        );
      const sendSelector =
        '[role="button"][aria-label="Press Enter to send"], button[aria-label="Press Enter to send"], [role="button"][aria-label="Натисніть Enter, щоб надіслати"], button[aria-label="Натисніть Enter, щоб надіслати"], [role="button"][aria-label="Нажмите Enter, чтобы отправить"], button[aria-label="Нажмите Enter, чтобы отправить"], [role="button"][aria-label="Send"], button[aria-label="Send"], [role="button"][aria-label="Надіслати"], button[aria-label="Надіслати"], [role="button"][aria-label="Отправить"], button[aria-label="Отправить"]';
      const composerActionSelector = `${sendSelector}, [role="button"][aria-label="Send a Like"], button[aria-label="Send a Like"], [role="button"][aria-label="Надіслати вподобайку"], button[aria-label="Надіслати вподобайку"], [role="button"][aria-label="Надіслать отметку Нравится"], button[aria-label="Надіслать отметку Нравится"]`;
      // Lexical can wrap the editor on input while the send action remains its
      // sibling. Expand only inside this content branch, never into its log/header.
      const fallbackComposer = (
        editor: Element,
        scope: Element,
        region: Element,
      ) => {
        for (
          let node = editor.parentElement;
          node && scope.contains(node) && !node.contains(region);
          node = node.parentElement
        ) {
          if (
            all(node, composerActionSelector).length === 1 &&
            all(node, composerSelector).length === 1 &&
            all(node, '[contenteditable="true"], [role="textbox"]').length ===
              1 &&
            !all(node, forbidden).length &&
            !chatControls(node).length
          )
            return node;
        }
        return editor.parentElement;
      };
      // The live third branch is unobserved. Accept incidental branches only
      // when all chat semantics stay exclusively in the immediate header/body.
      // Reuse this predicate through dispatch; never search a higher ancestor.
      const parentFailure = (
        content: Element,
        region: Element,
        composer: Element,
        counts: ParentStructureCounts = {},
      ): ParentStructureReason | undefined => {
        if (chatControls(content).length) return 'content_controls';
        const parent = content.parentElement;
        if (!parent) return 'parent_missing';
        if (parent === document.body) return 'parent_body';
        const measured = (
          key: keyof ParentStructureCounts,
          selector: string,
        ) => {
          const value = all(parent, selector).length;
          counts[key] = count(value);
          return value;
        };
        measured('childrenVisible', ':scope > *');
        if (measured('regionsVisible', regionSelector) !== 1)
          return 'parent_regions';
        if (measured('editorsVisible', composerSelector) !== 1)
          return 'parent_editors';
        if (measured('forbiddenVisible', forbidden)) return 'parent_forbidden';
        const headers = headersIn(parent, region, composer);
        // Header count and recipient identity are checked by the caller.
        if (headers.length !== 1) return;
        const header = headers[0]!;
        const controls = chatControls(header).map((node) =>
          normalize(node.getAttribute('aria-label') || node.textContent),
        );
        const logs = all(parent, '[role="log"]');
        const editor = all(content, composerSelector)[0];
        counts.actionsOutside = count(
          all(parent, composerActionSelector).filter(
            (node) => !composer.contains(node),
          ).length,
        );
        counts.extraEditors = count(
          all(parent, '[contenteditable="true"], [role="textbox"]').filter(
            (node) => node !== editor,
          ).length,
        );
        counts.extraComposers = count(
          all(parent, composerContainer).filter((node) => node !== composer)
            .length,
        );
        counts.linksOutside = count(
          all(parent, 'a[href]').filter(
            (node) =>
              !header.contains(node) &&
              !region.contains(node) &&
              identity(node),
          ).length,
        );
        if (
          new Set(controls).size !== controls.length ||
          chatControls(parent).some((node) => !header.contains(node)) ||
          logs.length > 1 ||
          logs.some(
            (node) =>
              node !== region &&
              !region.contains(node) &&
              !(node.contains(region) && !node.contains(composer)),
          ) ||
          all(parent, 'a[href]').some(
            (node) =>
              !header.contains(node) &&
              !region.contains(node) &&
              identity(node),
          ) ||
          all(parent, '[contenteditable="true"], [role="textbox"]').some(
            (node) => node !== editor,
          ) ||
          all(parent, composerContainer).some((node) => node !== composer) ||
          all(parent, composerActionSelector).some(
            (node) => !composer.contains(node),
          )
        )
          return 'parent_competing';
      };
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
            const composer =
              editor.closest(composerContainer) ??
              (editor.getAttribute('aria-placeholder') === 'Aa'
                ? fallbackComposer(editor, scope, region)
                : null);
            const editorName = namedLabel(editor, editorPattern);
            const regionLabel = normalize(region.getAttribute('aria-label'));
            const regionName = namedLabel(region, regionPattern);
            const localRecipientLinks = all(scope, 'a[href]').filter(
              (link) => identity(link) === recipient,
            );
            const name = normalizeName(
              editorName ||
                regionName ||
                (localRecipientLinks.length === 1
                  ? localRecipientLinks[0]!.getAttribute('aria-label') ||
                    localRecipientLinks[0]!.textContent
                  : (openedProfile?.name ?? '')),
            );
            const regionNameMatches =
              !regionLabel || Boolean(regionName && regionName === name);
            if (
              !name ||
              !regionNameMatches ||
              (editorName && regionName && editorName !== regionName)
            ) {
              reject('name_mismatch');
              break;
            }
            if (!composer || !scope.contains(composer)) {
              reject('composer_scope');
              break;
            }
            if (!composer.contains(editor)) {
              reject('composer_scope');
              break;
            }
            const contentScope = scope;
            let headers = headersIn(scope, region, composer);
            if (!headers.length) {
              // Support the observed header/body split when the nearest shared
              // messages/composer container is the body rather than the chat root.
              // Bind only that immediate semantic parent, without borrowing a
              // profile-page link outside this chat.
              const parent = scope.parentElement;
              const counts: ParentStructureCounts = {};
              const failure = parentFailure(
                contentScope,
                region,
                composer,
                counts,
              );
              if (failure) {
                observation.parentStructure = {
                  subreason: failure,
                  ...counts,
                };
                reject('parent_structure');
                break;
              }
              scope = parent!;
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
            const profileBound = profileBindingValid(header, name);
            if (profileBound) observation.nameMatch = true;
            if (
              !profileBound &&
              (recipientLinks.length !== 1 ||
                links.filter((link) => identity(link) === recipient).length !==
                  1 ||
                links.some(
                  (link) => identity(link) && identity(link) !== recipient,
                ))
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
            if (historyLoading(scope)) {
              reject('history_loading');
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
              link: profileBound
                ? profileHeaderNames(header, name)[0]!
                : recipientLinks[0]!,
              profileBound,
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
          profileBound,
          name,
        } = candidates[0]!;
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
        const inputText = () => {
          // Lexical paragraphs and inline text preserve spaces that innerText
          // can collapse. Read their boundaries explicitly; reject hidden text.
          if (
            Array.from(editor.querySelectorAll('*')).some(
              (node) =>
                !visible(node) ||
                node.getAttribute('contenteditable') === 'false',
            )
          )
            return null;
          const inline = (node: Element): string | null => {
            let text = '';
            for (const child of Array.from(node.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
              else if (child instanceof HTMLElement && child.tagName === 'BR')
                text += '\n';
              // Chromium fill can leave an empty trailing Lexical paragraph
              // after a direct text node; it carries no text or line break.
              else if (
                node === editor &&
                child instanceof HTMLElement &&
                /^(P|DIV)$/.test(child.tagName) &&
                !child.childNodes.length &&
                child === editor.lastChild
              )
                continue;
              else if (
                child instanceof HTMLElement &&
                child.tagName === 'SPAN' &&
                ['inline', 'contents'].includes(getComputedStyle(child).display)
              ) {
                const nested = inline(child);
                if (nested === null) return null;
                text += nested;
              } else return null;
            }
            return text;
          };
          const blocks = Array.from(editor.children);
          if (
            blocks.length &&
            blocks.length === editor.childNodes.length &&
            blocks.every((node) => /^(P|DIV)$/.test(node.tagName))
          ) {
            const lines = blocks.map((node) =>
              node.childNodes.length === 1 &&
              node.firstChild instanceof HTMLBRElement
                ? ''
                : inline(node),
            );
            // One LF per paragraph boundary, including empty paragraphs. Never
            // concatenate textContent across blocks or collapse repeated spaces.
            return lines.includes(null) ? null : lines.join('\n');
          }
          return inline(editor);
        };
        const valid = (filled: boolean) =>
          pinned.every(
            (node, index) => node.parentElement === parents[index],
          ) &&
          contentScope.contains(region) &&
          contentScope.contains(composer) &&
          (contentScope === scope ||
            (contentScope.parentElement === scope &&
              !parentFailure(contentScope, region, composer))) &&
          headersIn(scope, region, composer).length === 1 &&
          headersIn(scope, region, composer)[0] === header &&
          header.parentElement === scope &&
          (headerControls(header) ||
            (all(header, 'button, [role="button"]').length > 0 &&
              all(header, 'a[href]').some(
                (anchor) =>
                  identity(anchor) === recipient &&
                  namesRecipient(anchor, name),
              ))) &&
          header.contains(link) &&
          (profileBound
            ? profileBindingValid(header, name)
            : all(header, 'a[href]').filter(
                (anchor) => identity(anchor) === recipient,
              ).length === 1 &&
              !all(header, 'a[href]').some(
                (anchor) => identity(anchor) && identity(anchor) !== recipient,
              )) &&
          !header.contains(region) &&
          !header.contains(composer) &&
          composer.contains(editor) &&
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
          (profileBound
            ? profileHeaderNames(header, name)[0] === link
            : identity(link) === recipient && namesRecipient(link, name)) &&
          (!editor.getAttribute('aria-label') ||
            namedLabel(editor, editorPattern) === name) &&
          (!region.getAttribute('aria-label') ||
            namedLabel(region, regionPattern) === name) &&
          !historyLoading(scope) &&
          all(scope, composerSelector).length === 1 &&
          all(scope, composerSelector)[0] === editor &&
          all(scope, regionSelector).length === 1 &&
          all(scope, regionSelector)[0] === region &&
          !all(scope, forbidden).length &&
          (!filled ||
            ((editor as HTMLElement).isContentEditable &&
              inputText() === body &&
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
            observation.nameMatch =
              profileBindingValid(header, name) ||
              links.some((link) => namesRecipient(link, name));
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
        const messageId = (row: Element) => {
          const ids = new Set<string>();
          const nodes = [
            row,
            ...Array.from(row.querySelectorAll('[data-message-id]')),
          ];
          let parent = row.parentElement;
          while (parent && parent !== region && region.contains(parent)) {
            if (rows().filter((other) => parent!.contains(other)).length !== 1)
              break;
            nodes.push(parent);
            parent = parent.parentElement;
          }
          for (const node of nodes) {
            const id = node.getAttribute('data-message-id');
            if (id?.trim()) ids.add(id);
          }
          return ids.size === 1 ? [...ids][0] : undefined;
        };
        let stableRows: Element[] = [];
        let stableSignatures: (string | null)[] = [];
        let stableSince = performance.now();
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
          inputExactMatch: () => inputText() === body,
          matchesDraft: (draft: string) => {
            const text = inputText();
            return text !== null && normalize(text) === normalize(draft);
          },
          outgoingCount: () =>
            rows().filter((row) => sentRow(row) !== null).length,
          empty: () => {
            const empty = inputText() === '';
            if (!empty) observation.branch = 'draft';
            return empty;
          },
          button: () => sendButtons()[0]!,
          arm: () => {
            baseline = rows();
            signatures = baseline.map(sentRow);
          },
          externalMessageId: () => {
            const added = rows().filter(
              (row) => !baseline.includes(row) && sentRow(row) !== null,
            );
            return added.length === 1 ? messageId(added[0]!) : undefined;
          },
          recovered: (firstAttemptAt: string) => {
            if (!verify(false)) return null;
            const first = Date.parse(firstAttemptAt);
            if (!Number.isFinite(first)) return null;
            const matches = rows().flatMap((row) => {
              const signature = sentRow(row);
              if (signature === null) return [];
              const label = normalize(row.getAttribute('aria-label'));
              const time = label.slice(3, label.indexOf(', You: '));
              // Relative labels and minute-level timestamps overlapping the
              // attempt are inconclusive. Never infer them from the current day.
              if (
                !/^\d{1,2} [A-Za-z]+ \d{4}, \d{1,2}:\d{2}(?::\d{2})?(?: [AP]M)?$/.test(
                  time,
                )
              )
                return [];
              if (
                normalize((JSON.parse(signature) as string[])[1]!) !==
                `Enter, Message sent ${time} by You: ${normalize(body)}`
              )
                return [];
              const timestamp = Date.parse(time);
              const externalMessageId = messageId(row);
              return timestamp > first && timestamp <= Date.now()
                ? [
                    {
                      externalMessageId,
                      matchedOutgoingAt: new Date(timestamp).toISOString(),
                    },
                  ]
                : [];
            });
            const match = matches.length === 1 ? matches[0] : null;
            return match?.externalMessageId
              ? {
                  externalMessageId: match.externalMessageId,
                  matchedOutgoingAt: match.matchedOutgoingAt,
                }
              : null;
          },
          scrollToLatest: () => {
            stableSince = performance.now();
            for (
              let node: Element | null = region;
              node && scope.contains(node);
              node = node.parentElement
            )
              if (node.scrollHeight > node.clientHeight)
                node.scrollTop = node.scrollHeight;
          },
          tailReady: (quietMs: number) => {
            const current = rows();
            const signatures = current.map(sentRow);
            if (
              !verify(false) ||
              current.length !== stableRows.length ||
              current.some(
                (row, index) =>
                  row !== stableRows[index] ||
                  signatures[index] !== stableSignatures[index],
              )
            ) {
              stableRows = current;
              stableSignatures = signatures;
              stableSince = performance.now();
              return false;
            }
            return performance.now() - stableSince >= quietMs;
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
            if (
              current.filter((row) => sentRow(row) !== null).length !==
              signatures.filter((signature) => signature !== null).length + 1
            )
              return false;
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
    { recipient, body, openedProfile },
  );
  try {
    await page.waitForFunction((finder) => finder.find() !== null, finder, {
      timeout: timeoutMs,
    });
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

const facebookMessageActionName =
  /^(?:Message|Send message|Повідомлення|Надіслати повідомлення|Сообщение|Отправить сообщение)$/i;

// Extra wait for an optional h1 after the message action is already visible.
const HEADING_OBSERVE_MS = 2000;

export function facebookProfileActions(page: Page) {
  const main = page.locator('main, [role="main"]');
  return main
    .getByRole('button', { name: facebookMessageActionName })
    .or(main.getByRole('link', { name: facebookMessageActionName }))
    .filter({ visible: true });
}

export function facebookProfileHeadings(page: Page) {
  return page.locator('main h1, [role="main"] h1').filter({ visible: true });
}

export async function waitForFacebookProfileActions(
  page: Page,
  timeoutMs: number,
  allowMissing = false,
) {
  const headings = facebookProfileHeadings(page);
  const actions = facebookProfileActions(page);
  const tolerateTimeout = (error: unknown) => {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
  };
  if (allowMissing) {
    // Dry run: Facebook profiles can render without any h1, so the action is
    // awaited first and the heading is only observed, never required.
    await actions
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .catch(tolerateTimeout);
    await headings
      .first()
      .waitFor({
        state: 'visible',
        timeout: Math.min(timeoutMs, HEADING_OBSERVE_MS),
      })
      .catch(tolerateTimeout);
    return { headings, actions };
  }
  await headings.first().waitFor({ state: 'visible', timeout: timeoutMs });
  await actions.first().waitFor({ state: 'visible', timeout: timeoutMs });
  return { headings, actions };
}

export type FacebookRecipientObservation = {
  profileUrlMatches: boolean;
  headingFound: boolean;
  messageButtonCount: number;
  messageButtonCaption: string | null;
  messageButtonRole: 'button' | 'link' | null;
  extraWindowCount: number;
  hasNewMessageWindow: boolean;
  hasMiniChat: boolean;
  loginVisible: boolean;
  identityCheckVisible: boolean;
  checkpointVisible: boolean;
  language: string;
  elapsedMs: number;
  summaryUk: string;
};

export async function inspectFacebookRecipient(
  page: Page,
  recipient: string,
  timeoutMs: number,
): Promise<FacebookRecipientObservation> {
  const started = Date.now();
  const { headings, actions } = await waitForFacebookProfileActions(
    page,
    timeoutMs,
    true,
  );
  const headingFound = (await headings.count()) > 0;
  const messageButtonCount = await actions.count();
  const button = actions.first();
  const action = messageButtonCount
    ? await button.evaluate((node) => {
        const label =
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          node.textContent ||
          '';
        return {
          caption: label.replace(/\s+/g, ' ').trim().slice(0, 40) || null,
          role: node.matches('a, [role="link"]') ? 'link' : 'button',
        };
      })
    : null;
  const pageFlags = await page.evaluate(() => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible' &&
      !node.closest('[hidden], [aria-hidden="true"], [inert]');
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
    ).filter(visible);
    const logs = Array.from(document.querySelectorAll('[role="log"]')).filter(
      visible,
    );
    const editors = Array.from(
      document.querySelectorAll(
        '[contenteditable="true"][role="textbox"], textarea[placeholder]',
      ),
    ).filter(visible);
    const visibleText = (node: Element) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const newMessage = dialogs.some((node) => {
      const heading = Array.from(
        node.querySelectorAll('h1, h2, h3, [role="heading"]'),
      )
        .filter(visible)
        .map(visibleText);
      return heading.some((text) =>
        /^(?:Нове повідомлення|New message|Новое сообщение)$/i.test(text),
      );
    });
    const checkpoint = Array.from(
      document.querySelectorAll(
        'form[action*="checkpoint"], [aria-label*="Confirm you"], [aria-label*="Підтвердьте"], [aria-label*="Подтвердите"]',
      ),
    ).some(visible);
    const login = Array.from(
      document.querySelectorAll(
        'input[name="email"], input[name="pass"], form[action*="login"], [aria-label="Log in"], [aria-label="Увійти"]',
      ),
    ).some(visible);
    const identity = Array.from(
      document.querySelectorAll('form, [role="dialog"], [role="main"]'),
    )
      .filter(visible)
      .some((node) =>
        /confirm your identity|confirm it.s you|підтвердьте свою особу|підтвердіть, що це ви|подтвердите, что это вы/i.test(
          visibleText(node).slice(0, 500),
        ),
      );
    return {
      extraWindowCount: dialogs.length,
      hasNewMessageWindow: newMessage,
      hasMiniChat: logs.length > 0 || editors.length > 0,
      loginVisible: login,
      identityCheckVisible: identity,
      checkpointVisible: checkpoint,
      language: document.documentElement.lang.slice(0, 20),
    };
  });
  const profileUrlMatches = socialTarget(page.url())?.handle === recipient;
  const summaryUk =
    pageFlags.checkpointVisible || pageFlags.loginVisible
      ? 'Facebook просить підтвердити вхід. Відкрийте браузер і підтвердьте.'
      : messageButtonCount === 1 && profileUrlMatches
        ? headingFound
          ? 'Профіль відкрито, кнопку «Повідомлення» знайдено.'
          : 'Профіль відкрито, кнопку «Повідомлення» знайдено, але заголовка h1 на сторінці немає.'
        : messageButtonCount === 0
          ? 'Кнопку «Повідомлення» не знайдено — перегляньте знімок.'
          : messageButtonCount > 1
            ? 'Знайдено кілька кнопок «Повідомлення». Потрібна дія: перегляньте знімок і перевірте профіль.'
            : 'Профіль одержувача не підтверджено. Потрібна дія: перевірте посилання та знімок.';
  return {
    profileUrlMatches,
    headingFound,
    messageButtonCount,
    messageButtonCaption: action?.caption ?? null,
    messageButtonRole: (action?.role as 'button' | 'link' | undefined) ?? null,
    ...pageFlags,
    elapsedMs: Date.now() - started,
    summaryUk,
  };
}

export async function sendFacebook(
  page: Page,
  target: SocialTarget,
  timeoutMs: number,
  body: string,
  beforeSend: () => Promise<void>,
  assertSession: (timeoutMs?: number) => Promise<void>,
  draft?: SocialComposerDraft,
  captureFailure?: (
    phase: string,
    elapsedMs: number,
  ) => Promise<boolean | void>,
): Promise<FacebookDispatchResult> {
  const startedAt = Date.now();
  let failureCaptured = false;
  const markCaptured = (error: unknown) => {
    if (failureCaptured && error && typeof error === 'object')
      Object.assign(error, { failureShotCaptured: true });
  };
  let attempted = false;
  const facts: FacebookDispatchResult['observation'] = {
    inputExactMatch: false,
    dispatchPerformed: false,
    outgoingBefore: 0,
    outgoingAfter: 0,
    newOutgoing: false,
    observationMs: 0,
    lateError: 'none',
  };
  let observationStarted = 0;
  let phase = 'navigation';
  let observation: Observation | undefined;
  let branch = 'not_observed';
  const observe = (value: Observation) => {
    observation = value;
  };
  const diagnostic = (error: unknown) =>
    JSON.stringify({
      version: 'fb-profile-chat-v2',
      phase,
      transmission: facts,
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
  let dispatchStarted = false;
  let transportFailure: 'network' | 'http_error' | undefined;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      /^(www\.)?facebook\.com$/.test(url.hostname) &&
      response.status() === 429 &&
      ['document', 'xhr', 'fetch'].includes(response.request().resourceType())
    )
      restricted = true;
    if (
      dispatchStarted &&
      /^(www\.)?facebook\.com$/.test(url.hostname) &&
      response.status() >= 400 &&
      ['document', 'xhr', 'fetch'].includes(response.request().resourceType())
    ) {
      transportFailure = 'http_error';
      facts.lateError = 'http_error';
    }
  });
  page.on('requestfailed', (request) => {
    if (
      dispatchStarted &&
      /^(www\.)?facebook\.com$/.test(new URL(request.url()).hostname) &&
      ['document', 'xhr', 'fetch'].includes(request.resourceType())
    ) {
      transportFailure = 'network';
      facts.lateError = 'network';
    }
  });
  const check = async (sessionTimeoutMs?: number) => {
    if (restricted) throw new SocialSessionCheckError('rate_limit');
    if (transportFailure) {
      facts.lateError = transportFailure;
      throw unavailable();
    }
    try {
      await assertSession(sessionTimeoutMs);
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
    const response = await navigateSocialPage(
      page,
      target.canonicalUrl,
      timeoutMs,
    ).catch((error: unknown) => {
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
    // Hash only the allowlisted identity cookie inside the existing context.
    // Neither cookie values nor the raw account identifier leave this scope.
    const identities = new Set(
      (await page.context().cookies('https://www.facebook.com'))
        .filter(
          (cookie) => cookie.name === 'c_user' && /^\d+$/.test(cookie.value),
        )
        .map((cookie) => cookie.value),
    );
    if (identities.size === 1)
      facts.senderFingerprint = createHash('sha256')
        .update([...identities][0]!)
        .digest('hex')
        .slice(0, 12);
    phase = 'profile';
    if (socialTarget(page.url())?.handle !== target.handle)
      throw unavailable('profile_mismatch');
    const { actions } = await waitForFacebookProfileActions(page, timeoutMs);
    if ((await actions.count()) !== 1) throw unavailable('action_count');
    // Bind either the existing popup or the profile action to this visible H1
    // when its header exposes a name instead of a canonical recipient link.
    const actionIsButton = await actions.evaluate((action) =>
      action.matches('button, [role="button"]'),
    );
    const openedProfile = await page.evaluate((actionIsButton) => {
      const visible = (node: Element) =>
        node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === 'visible' &&
        !node.closest('[hidden], [aria-hidden="true"], [inert]');
      const headings = Array.from(
        document.querySelectorAll('main h1, [role="main"] h1'),
      ).filter(visible);
      const editors = Array.from(
        document.querySelectorAll(
          '[contenteditable="true"][role="textbox"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"][aria-placeholder="Aa"]',
        ),
      ).filter(visible);
      const regions = Array.from(
        document.querySelectorAll(
          '[aria-label^="Messages in conversation with "], [aria-label^="Повідомлення в розмові з "], [aria-label^="Сообщения в переписке с "], [role="log"]',
        ),
      ).filter(visible);
      const name = headings[0]?.textContent?.replace(/\s+/g, ' ').trim();
      return actionIsButton &&
        headings.length === 1 &&
        name &&
        editors.length <= 1 &&
        regions.length === editors.length
        ? { url: location.href, name }
        : undefined;
    }, actionIsButton);
    const existing = page
      .locator(
        '[contenteditable="true"][role="textbox"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"][aria-placeholder="Aa"]',
      )
      .filter({ visible: true });
    let reuse = false;
    if (await existing.count()) {
      if (!openedProfile || (await existing.count()) !== 1) throw unavailable();
      const popup = await existing.evaluateHandle((editor, profile) => {
        const normalize = (text: string | null) =>
          (text ?? '')
            .replace(
              /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\ufe0e|\ufe0f/g,
              '',
            )
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
            .replace(/(?:\s*[⌄▾▼∨˅›❯⌃▴▲‹❮〉〈>])+$/u, '')
            .trim();
        const visible = (node: Element) =>
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility === 'visible' &&
          !node.closest('[hidden], [aria-hidden="true"], [inert]');
        for (
          let scope = editor.parentElement;
          scope && scope !== document.body;
          scope = scope.parentElement
        ) {
          const regions = Array.from(
            scope.querySelectorAll(
              '[role="log"], [aria-label^="Messages in conversation with "]',
            ),
          ).filter(visible);
          const closers = Array.from(
            scope.querySelectorAll('button, [role="button"]'),
          ).filter(
            (node) =>
              visible(node) &&
              /^(?:close chat|закрити чат|закрыть чат)$/i.test(
                (
                  node.getAttribute('aria-label') ||
                  node.textContent ||
                  ''
                ).trim(),
              ),
          );
          if (!regions.length || !closers.length) continue;
          if (
            regions.length !== 1 ||
            closers.length !== 1 ||
            scope.querySelector('main, nav, [role="main"], [role="navigation"]')
          )
            return null;
          let header = closers[0]!;
          while (header.parentElement && header.parentElement !== scope)
            header = header.parentElement;
          if (header.contains(editor) || header.contains(regions[0]!))
            return null;
          const names = Array.from(
            header.querySelectorAll('a, button, [role="button"], span'),
          );
          const identity = (href: string) => {
            try {
              const url = new URL(href, location.href);
              if (
                url.protocol !== 'https:' ||
                !/^(www\.)?facebook\.com$/.test(url.hostname)
              )
                return null;
              return url.pathname === '/profile.php'
                ? url.searchParams.get('id')
                : /^\/([\w.-]+)\/?$/.exec(url.pathname)?.[1]?.toLowerCase();
            } catch {
              return null;
            }
          };
          const identities = Array.from(header.querySelectorAll('a[href]'))
            .map((link) => identity(link.getAttribute('href')!))
            .filter(Boolean);
          const reuse =
            identities.every((id) => id === identity(profile.url)) &&
            names.some(
              (node) =>
                visible(node) &&
                [node.textContent, node.getAttribute('aria-label')].some(
                  (text) => normalize(text) === normalize(profile.name),
                ),
            );
          return { scope, close: closers[0]!, reuse };
        }
        return null;
      }, openedProfile);
      try {
        if (!(await popup.evaluate((popup) => Boolean(popup))))
          throw unavailable();
        reuse = await popup.evaluate((popup) => popup!.reuse);
        if (!reuse) {
          const close = (
            await popup.evaluateHandle((popup) => popup!.close)
          ).asElement();
          if (!close) throw unavailable();
          const guard = await close.evaluateHandle((button, popup) => {
            const parent = button.parentElement;
            let blocked = false;
            const guard = (event: Event) => {
              if (!event.composedPath().includes(button)) return;
              blocked ||=
                !button.isConnected ||
                button.parentElement !== parent ||
                !popup!.scope.contains(button) ||
                !/^(?:close chat|закрити чат|закрыть чат)$/i.test(
                  (
                    button.getAttribute('aria-label') ||
                    button.textContent ||
                    ''
                  ).trim(),
                );
              if (blocked) {
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
            for (const boundary of [window, popup!.scope, button])
              for (const event of events)
                boundary.addEventListener(event, guard, {
                  capture: true,
                  passive: false,
                });
            return {
              blocked: () => blocked,
              cleanup: () => {
                for (const boundary of [window, popup!.scope, button])
                  for (const event of events)
                    boundary.removeEventListener(event, guard, true);
              },
            };
          }, popup);
          try {
            await close.click();
            if (await guard.evaluate((guard) => guard.blocked()))
              throw unavailable();
          } finally {
            await guard.evaluate((guard) => guard.cleanup()).catch(() => {});
            await guard.dispose();
          }
          await page.waitForFunction(
            (popup) =>
              !popup!.scope.isConnected ||
              !popup!.scope.getClientRects().length,
            popup,
            { timeout: timeoutMs },
          );
        }
      } finally {
        await popup.dispose();
      }
    }
    if (!reuse) await actions.click();
    await check();
    phase = 'first_lookup';
    let state = await conversation(
      page,
      target.handle,
      body,
      observe,
      timeoutMs,
      openedProfile,
    );
    try {
      if (!(await state.evaluate((state) => Boolean(state))))
        throw unavailable();
      // Establish the tail before baseline counting; virtualized history may
      // otherwise replace old bubbles during dispatch and invalidate evidence.
      await state.evaluate((state) => state?.scrollToLatest());
      // Wait for loading and mounted-row replacements to settle before taking
      // the baseline. A changing virtualized tail must stop us before dispatch.
      await page.waitForFunction(
        ({ state, quietMs }) => state?.tailReady(quietMs),
        { state, quietMs: Math.min(200, timeoutMs / 2) },
        { timeout: timeoutMs },
      );
      await state.dispose();
      state = await conversation(
        page,
        target.handle,
        body,
        observe,
        timeoutMs,
        openedProfile,
      );
      if (draft?.recoveryFirstAttemptAt !== undefined) {
        phase = 'recovery';
        await page.waitForFunction(
          ({ state, first }) => state?.recovered(first),
          { state, first: draft.recoveryFirstAttemptAt },
          { timeout: timeoutMs },
        );
        await check();
        const recovered = await state.evaluate(
          (state, first) => state?.recovered(first),
          draft.recoveryFirstAttemptAt,
        );
        if (!recovered)
          throw new SocialSendError(
            'delivery_uncertain',
            'Попередню доставку Facebook не підтверджено. Перевірте чат вручну; автоматичний повтор заблоковано.',
          );
        const count = await state.evaluate((state) => state!.outgoingCount());
        return {
          outcome: 'facebook_reconciled',
          dialogUrl: target.canonicalUrl,
          externalMessageId: recovered.externalMessageId,
          observation: {
            ...facts,
            outgoingBefore: count,
            outgoingAfter: count,
            matchedOutgoingAt: recovered.matchedOutgoingAt,
          },
        };
      }
      if (
        !(await state.evaluate(
          (state, previousBodies) =>
            state?.valid(false) &&
            (state.empty() ||
              previousBodies.some((body) => state.matchesDraft(body))),
          [
            ...(draft?.previousBodies ?? []),
            ...(draft?.previousBody !== undefined ? [draft.previousBody] : []),
          ],
        ))
      )
        throw new SocialSendError(
          'unavailable',
          'Поле повідомлення містить непідтверджену чернетку. Перевірте й очистіть його вручну.',
        );
      const editor = (
        await state.evaluateHandle((state) => state!.editor)
      ).asElement();
      if (!editor) throw unavailable();
      await draft?.beforeFill();
      // Recheck persisted recovery evidence before replacing an existing draft.
      if (
        !(await state.evaluate(
          (state, previousBodies) =>
            state?.valid(false) &&
            (state.empty() ||
              previousBodies.some((body) => state.matchesDraft(body))),
          [
            ...(draft?.previousBodies ?? []),
            ...(draft?.previousBody !== undefined ? [draft.previousBody] : []),
          ],
        ))
      )
        throw unavailable();
      phase = 'after_fill';
      await editor.fill(body);
      // Lexical may rerender during fill. Rebind only before the durable marker.
      await state.dispose();
      state = await conversation(
        page,
        target.handle,
        body,
        observe,
        timeoutMs,
        openedProfile,
      );
      if (!(await state.evaluate((state) => state?.valid(true))))
        throw unavailable();
      facts.inputExactMatch = await state.evaluate((state) =>
        state!.inputExactMatch(),
      );
      if (!facts.inputExactMatch) throw unavailable();
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
      const outgoingBefore = await state.evaluate((state) =>
        state!.outgoingCount(),
      );
      facts.outgoingBefore = Math.min(99, outgoingBefore);
      phase = 'dispatch';
      dispatchStarted = true;
      await button.click(); // Exactly one dispatch, never retry after the marker.
      if (await state.evaluate((state) => state!.blocked()))
        throw unavailable();
      facts.dispatchPerformed = true;
      observationStarted = Date.now();
      phase = 'confirmation';
      await page.waitForFunction((state) => state?.confirmed(), state, {
        timeout: timeoutMs,
      });
      await check();
      if (page.url() !== dialogUrl) throw unavailable('url_changed');
      if (!(await state.evaluate((state) => state?.confirmed())))
        throw unavailable();
      const outgoingAfter = await state.evaluate((state) =>
        state!.outgoingCount(),
      );
      facts.outgoingAfter = Math.min(99, outgoingAfter);
      // Keep semantic detection separate from saturated telemetry counts.
      facts.newOutgoing = await state.evaluate((state) => state!.confirmed());
      // Keep the original page alive for transmission using the existing timeout,
      // without shortening it. Elapsed time is not proof of server delivery.
      const until = Date.now() + timeoutMs;
      phase = 'transmission';
      while (Date.now() < until) {
        await page.waitForTimeout(Math.min(200, until - Date.now()));
        facts.observationMs = Date.now() - observationStarted;
        try {
          // A tiny remaining timer budget can falsely fail a visible auth check.
          // Bound each check independently; the hold can overrun by at most 200 ms.
          await check(Math.min(timeoutMs, 200));
        } catch (error) {
          facts.lateError =
            transportFailure ?? (restricted ? 'rate_limit' : 'session');
          throw error;
        }
        if (
          page.url() !== dialogUrl ||
          !(await state.evaluate((state) => state?.confirmed()))
        ) {
          facts.lateError = 'outgoing_changed';
          throw unavailable();
        }
      }
      facts.observationMs = Date.now() - observationStarted;
      // Floating chat has no thread URL: preserve its verified profile link.
      return {
        outcome: 'facebook_dispatched_unconfirmed',
        dialogUrl: target.canonicalUrl,
        observation: facts,
        externalMessageId: await state.evaluate((state) =>
          state?.externalMessageId(),
        ),
      };
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
    // Capture the failing DOM before a second session check can navigate or
    // otherwise change the page. The outer withPage capture remains a fallback.
    if (captureFailure && !failureCaptured) {
      const stored = await captureFailure(phase, Date.now() - startedAt)
        .then((result) => result !== false)
        .catch(() => false);
      failureCaptured = stored;
    }
    // Explicit auth/checkpoint/rate-limit evidence pauses the account. A closed
    // page or failed recheck must still be uncertain after the durable marker.
    if (observationStarted)
      facts.observationMs = Date.now() - observationStarted;
    if (phase === 'transmission' && facts.lateError === 'none')
      facts.lateError = 'browser';
    const detail = diagnostic(error);
    let caught = error;
    try {
      await check(
        phase === 'transmission' ? Math.min(timeoutMs, 200) : undefined,
      );
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
      markCaptured(caught);
      throw caught;
    }
    if (attempted || draft?.recoveryFirstAttemptAt !== undefined) {
      const failure = new SocialSendError(
        'delivery_uncertain',
        `[facebook/${phase}] Доставку не підтверджено. Перевірте чат вручну; не повторюйте надсилання автоматично. ${detail}`,
      );
      markCaptured(failure);
      throw failure;
    }
    if (caught instanceof SocialSendError && caught.code === 'unavailable') {
      caught.reasonUk += ` ${detail}`;
      markCaptured(caught);
      throw caught;
    }
    const failure = unavailable();
    failure.reasonUk += ` ${detail}`;
    markCaptured(failure);
    throw failure;
  }
}
