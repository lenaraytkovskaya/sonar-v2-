import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createSocialSendBrowser } from './social-send-browser.js';

// The captured variant preserves every element and its nesting from the supplied
// floating chat, including actual outgoing markup. Names, IDs, times and messages
// are synthetic; resource/style attributes are removed. Other variants below use
// generic synthetic wrappers. The stylesheet and UI event behavior are synthetic.
const observedChat = readFileSync(
  new URL('./facebook-chat.sanitized.fixture.html', import.meta.url),
  'utf8',
);
const markup = `
<meta charset="utf-8">
<style>[contenteditable] { min-height: 24px; } [aria-label^="Messages in conversation"], [role="log"] { min-height: 30px; } [role="button"] { min-height: 18px; min-width: 18px; }</style>
<nav aria-label="Account"><a href="/100000000000009/">Synthetic self</a></nav>
<main><h1>Synthetic recipient</h1><button id="open">Message</button></main>
<div id="chats"></div>
<script>
const o = window.fixtureOptions;
const observedChat = ${JSON.stringify(observedChat)};
const body = o.whitespaceBody ? 'Synthetic  message' : o.multilineBody ? 'Synthetic\\nmessage' : o.bodySending ? 'Sending' : o.bodyPending ? 'Pending review' : 'Synthetic message';
const recipient = o.company ? 'synthetic_company' : '100000000000001';
const label = 'Synthetic Recipient';
let fixtureMessageId = 100;
function row(own = true, text = body, time = '4 November 2026, 20:15') {
  if (o.observed) {
    const template = document.createElement('template'); template.innerHTML = observedChat;
    const wrapper = template.content.querySelector('[aria-label^="At "]').closest('[role="article"]');
    if (o.noMessageId) for (const node of [wrapper,...wrapper.querySelectorAll('[data-message-id]')]) node.removeAttribute('data-message-id');
    const content = wrapper.querySelector('[aria-label^="At "]');
    if (!o.noMessageId) content.setAttribute('data-message-id', 'synthetic-outgoing-' + ++fixtureMessageId);
    const sent = wrapper.querySelector('[aria-label^="Enter, Message sent "]');
    content.setAttribute('aria-label', 'At ' + time + ', ' + (own ? 'You' : 'Synthetic Recipient') + ': ' + text);
    sent.setAttribute('aria-label', 'Enter, Message sent ' + time + ' by ' + (own ? 'You' : 'Synthetic Recipient') + ': ' + text);
    if (o.quotedUk) {
      content.setAttribute('aria-label', 'О ' + time + ', Ви: «' + text + '»');
      content.querySelector('h2').textContent = 'Ви надіслали';
      sent.setAttribute('aria-label', 'Enter, Повідомлення від користувача Ви о ' + time + ': «' + text + '»');
    }
    for (const node of content.querySelectorAll('*')) {
      if (!node.children.length && node.textContent === 'Synthetic message 1') node.textContent = text;
    }
    return wrapper;
  }
  const wrapper = document.createElement('div');
  const sender = own ? 'You' : 'Synthetic Recipient';
  if (o.structuralOnly) {
    // Labels in a language the code has never seen: only structure identifies the row.
    wrapper.setAttribute('role', 'article');
    const id = (own ? '100000000000009' : '100000000000001') + '@msgr.' + String(Date.now()).padEnd(19, '7');
    wrapper.innerHTML = '<div data-scope="messages_table" data-message-id="' + id + '" aria-label="xx ' + time + ' qq: ' + text + '" aria-roledescription="zz"><div dir="auto">' + text + '</div></div>';
    return wrapper;
  }
  if (o.ukLabels) {
    wrapper.innerHTML = '<div aria-label="\u041e ' + time + ', ' + (own ? '\u0412\u0438' : sender) + ': ' + text + '"><h2>' +
      (own ? '\u0412\u0438 \u043d\u0430\u0434\u0456\u0441\u043b\u0430\u043b\u0438' : sender) + '</h2><span>' + text + '</span></div>' +
      '<div role="button" aria-label="Enter, \u041f\u043e\u0432\u0456\u0434\u043e\u043c\u043b\u0435\u043d\u043d\u044f \u0432\u0456\u0434 \u043a\u043e\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0447\u0430 ' + (own ? '\u0412\u0438' : sender) + ' \u043e ' + time + ': \u00ab' + text + '\u00bb"></div>';
    return wrapper;
  }
  wrapper.innerHTML = '<div aria-label="At ' + time + ', ' + sender + ': ' + text + '"><h2>' +
    (own ? 'You sent' : sender) + '</h2><span>' + text + '</span></div>' +
    '<div role="button" aria-label="Enter, Message sent ' + time + ' by ' + sender + ': ' + text + '"></div>';
  return wrapper;
}
function chat(id, target, name) {
  const scope = document.createElement('div'); scope.id = id;
  if (o.observed) {
    scope.innerHTML = observedChat;
    const captured = scope.firstElementChild;
    captured.id = id;
    if (o.quotedUk) for (const article of captured.querySelectorAll('[role=article]')) {
      const row = article.querySelector('[aria-label^="At "]');
      if (!row || !row.getAttribute('aria-label').includes(', You: ')) continue;
      const text = row.querySelector('div[dir=auto]').textContent;
      row.setAttribute('aria-label', 'О 4 November 2026, 20:15, Ви: «' + text + '»');
      row.querySelector('h2').textContent = 'Ви надіслали';
      article.querySelector('[aria-label^="Enter, Message sent"]').setAttribute('aria-label', 'Enter, Повідомлення від користувача Ви о 4 November 2026, 20:15: «' + text + '»');
    }
    captured.querySelector('a').href = 'https://www.facebook.com/' + target + '/';
    captured.querySelector('a').setAttribute('aria-label', name);
    captured.querySelector('[contenteditable]').setAttribute('aria-label', 'Write to ' + name);
    captured.querySelector('[aria-label^="Messages in conversation"]').setAttribute('aria-label', 'Messages in conversation with ' + name);
    return captured;
  }
  if (o.e2eeAa || o.headerNameButton) {
    const headerTarget = o.wrongRecipient ? '100000000000002' : target;
    const recipientHeader = o.headerNameButton
      ? '<span><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></span><button data-fixture-recipient><span>' + (o.headerNameMismatch ? 'Other Recipient' : name) + '</span><svg aria-hidden="true"><path d="M0 0 L4 4 L8 0" /></svg></button>'
      : '<a href="https://www.facebook.com/' + headerTarget + '/">' + name + '</a>';
    scope.innerHTML = '<div>' + recipientHeader +
      '<button role="button" aria-label="Налаштування чату"></button><button aria-label="Почати голосовий виклик"></button>' +
      '<button aria-label="Почати відеодзвінок"></button><button aria-label="Згорнути чат"></button><button aria-label="Закрити чат"></button></div>' +
      '<div role="log"><section aria-label="End-to-end encryption"><h2>Restore messages</h2><p>Personal chats are secured with end-to-end encryption.</p><button>Restore now</button></section></div>' +
      '<div><div contenteditable="true" role="textbox" aria-placeholder="Aa"><p></p></div>' +
      '<button role="button" aria-label="Send a Like"></button></div>';
    scope.querySelector('section button').addEventListener('click', () => {
      void window.fixtureEvent('restore');
    });
    if (o.headerNameButton) {
      if (o.decoratedHeader) {
        const header = scope.querySelector('[data-fixture-recipient]');
        header.innerHTML = '<span>  SYNTHETIC &#8203;  recipient&#65279; </span><span>⌄</span><svg><title>Open chat options</title></svg><span aria-hidden="true">Icon</span>';
        header.setAttribute('aria-label', 'Synthetic Recipient ⌄');
        scope.querySelector('[aria-label="Налаштування чату"]').remove();
      }
      if (o.duplicateHeaderName) scope.firstElementChild.insertAdjacentHTML('beforeend', '<button>Synthetic Recipient</button>');
      if (o.normalizedIdentityLabels) {
        scope.querySelector('[contenteditable]').setAttribute('aria-label', 'Write to SYNTHETIC &#8203; recipient'.replace('&#8203;', String.fromCharCode(8203)));
        scope.querySelector('[role="log"]').setAttribute('aria-label', 'Messages in conversation with synthetic  RECIPIENT');
      }
      if (o.headerWrongParentLabel) scope.querySelector('[data-fixture-recipient]').setAttribute('aria-label', 'Other Recipient');
      if (o.headerSpan || o.headerLink) {
        const original = scope.querySelector('[data-fixture-recipient]');
        const replacement = document.createElement(o.headerLink ? 'a' : 'span');
        replacement.textContent = original.textContent;
        replacement.setAttribute('data-fixture-recipient', '');
        if (o.headerLink) replacement.href = '/profile.php?id=' + (o.wrongRecipient ? '100000000000002' : target);
        original.replaceWith(replacement);
      }
      if (o.headerAvatar) {
        const avatar = document.createElement('a');
        avatar.href = '/profile.php?id=' + (o.wrongAvatarRecipient ? '100000000000002' : target);
        avatar.innerHTML = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
        if (o.wrongAvatarLabel) avatar.setAttribute('aria-label', 'Other Recipient');
        if (o.wrongAvatarText) avatar.append('Other Recipient');
        scope.firstElementChild.prepend(avatar);
      }
      if (o.ukrainianRestore) {
        scope.querySelector('section h2').textContent = 'Відновіть повідомлення';
        scope.querySelector('section button').textContent = 'Відновити зараз';
        document.querySelector('#open').textContent = 'Повідомлення';
      }
      const restore = scope.querySelector('section');
      const content = document.createElement('div');
      while (scope.children[1]) content.append(scope.children[1]);
      scope.append(content, restore);
    }
    return scope;
  }
  // Header-like generic container, deliberately not a header element.
  scope.innerHTML = '<div><a href="https://www.facebook.com/' + target + '/">' + name + '</a>' +
    '<div role="button" aria-label="Chat settings" aria-haspopup="menu"></div>' +
    '<button>Start a voice call</button><button>Start a video call</button><button>Minimise chat</button><button>Close chat</button></div>' +
    '<h2>Messages</h2><div aria-label="Messages in conversation with ' + name + '"></div>' +
    '<div aria-label="Thread composer"><div contenteditable="true" role="textbox" spellcheck="true" tabindex="0" ' +
    'aria-describedby="synthetic-description" aria-label="Write to ' + name + '" aria-placeholder="Aa" data-lexical-editor="true"><p dir="auto"></p></div>' +
    '<div role="button" tabindex="0" aria-label="Send a Like"><svg><title>Send a Like</title></svg></div></div>';
  if (o.avatarLink) {
    const link = scope.querySelector('a');
    link.setAttribute('aria-label', name); link.innerHTML = '<span><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></span><div role="none"></div>';
    const settings = scope.querySelector('[aria-label="Chat settings"]');
    settings.setAttribute('aria-haspopup', 'dialog'); settings.innerHTML = '<h2 dir="auto"><span>' + name + '</span></h2>';
    if (o.wrongAvatarLabel) link.setAttribute('aria-label', 'Other Recipient');
  }
  if (o.wrappedChatBody) {
    const body = document.createElement('div');
    while (scope.children[1]) body.append(scope.children[1]);
    if (o.extraBodyWrapper) {
      const wrapper = document.createElement('div'); wrapper.append(body); scope.append(wrapper);
    } else scope.append(body);
  }
  return scope;
}
const region = scope => scope.querySelector('[aria-label^="Messages in conversation"], [aria-label^="Повідомлення в розмові"], [aria-label^="Сообщения в переписке"], [role="log"]');
function historySpinner(scope, phase) {
  const spinner = document.createElement('div');
  spinner.style.minHeight = '24px';
  spinner.setAttribute('role', 'progressbar');
  spinner.setAttribute('aria-label', 'Loading messages');
  region(scope).append(spinner);
  if (!o.spinnerRemains) setTimeout(() => {
    spinner.remove(); window.fixtureEvent('history-ready:' + phase);
  }, 90);
}
function wire(scope) {
  for (const control of scope.querySelectorAll('button, [role="button"]')) {
    const label = control.getAttribute('aria-label') || control.textContent;
    if (/^(?:Close chat|Закрити чат)$/i.test(label)) control.addEventListener('click', () => {
      window.fixtureEvent('close:' + scope.id); scope.remove();
    });
    if (/call|виклик|відеодзвінок/i.test(label)) control.addEventListener('click', () => window.fixtureEvent('call'));
    if (o.closeMutatesToCall && /^(?:Close chat|Закрити чат)$/i.test(label)) {
      control.addEventListener('mousedown', () => control.setAttribute('aria-label', 'Start a voice call'));
      control.addEventListener('click', () => window.fixtureEvent('call'));
    }
  }
  const editor = scope.querySelector('[contenteditable]');
  const button = scope.querySelector('[aria-label="Send a Like"], [aria-label="Press Enter to send"]');
  editor.addEventListener('input', () => {
    window.fixtureEvent('input:' + scope.id);
    button.setAttribute('aria-label', editor.textContent ? 'Press Enter to send' : 'Send a Like');
    if (o.lexicalWrap && !editor.querySelector('p')) {
      const paragraph = document.createElement('p'); const text = document.createElement('span');
      text.textContent = editor.textContent; paragraph.append(text); editor.replaceChildren(paragraph);
      const wrapper = document.createElement('div'); editor.replaceWith(wrapper); wrapper.append(editor);
    }
    if (o.whitespaceBody || o.multilineBody) {
      editor.replaceChildren(...body.split('\\n').map(line => {
        const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph;
      }));
    }
    if (o.lexicalNewline) {
      const text = editor.textContent; editor.innerHTML = '<p><span></span></p>';
      editor.querySelector('span').textContent = text;
      Object.defineProperty(editor, 'innerText', { configurable: true, get: () => text + '\\n' });
    }
    if (o.splitDraftWords) editor.innerHTML = '<p>Synthetic</p><p>message</p>';
    if (o.breakDraftWords) editor.innerHTML = '<span>Synthetic<br>message</span>';
    if (o.unsupportedInline) editor.innerHTML = '<em>' + editor.textContent + '</em>';
    if (o.hiddenDraftText) editor.insertAdjacentHTML('beforeend', '<span hidden>Unexpected draft text</span>');
    if (o.extraDraftParagraph) editor.insertAdjacentHTML('beforeend', '<p>Unexpected paragraph</p>');
    if (o.emptyDraftParagraph) editor.insertAdjacentHTML('beforeend', '<p><br></p>');
    if (o.afterFillSpinner) historySpinner(scope, 'after_fill');
    if (o.afterFillHeaderName) scope.querySelector('[data-fixture-recipient]').textContent = 'Other Recipient';
    if (o.afterFillProfileName) document.querySelector('main h1').textContent = 'Other Recipient';
    if (o.rerenderFill && !window.rerendered) {
      window.rerendered = true; const replacement = scope.cloneNode(true); scope.replaceWith(replacement); wire(replacement);
    }
  });
  button.addEventListener('click', () => {
    window.fixtureEvent('send:' + scope.id);
    if (o.afterSendCheckpoint) { document.body.insertAdjacentHTML('beforeend', '<form action="/checkpoint/"><button>Continue</button></form>'); return; }
    if (o.eraseOnly) { editor.textContent = ''; return; }
    if (o.rerenderAfterSend) { region(scope).innerHTML = region(scope).innerHTML; return; }
    if (o.prependHistory) { region(scope).prepend(row()); return; }
    if (o.identifyHistory) {
      region(scope).querySelector('[aria-roledescription="zz"]').setAttribute('data-message-id', '100000000000009@msgr.99');
      return;
    }
    if (o.oldOnly) return;
    const destination = o.sendInNeighbour ? region(document.querySelector('#neighbour')) : region(scope);
    const next = row(!o.incoming, body, o.sameTimestamp ? '4 November 2026, 20:15' : '4 November 2026, 20:16');
    if (o.missingSelf) next.querySelector('h2').textContent = 'Synthetic Recipient';
    if (o.pending || o.failed) next.insertAdjacentHTML('beforeend', '<span>' + (o.pending ? 'Sending' : 'Not sent. Retry') + '</span>');
    if (o.nestedPending || o.nestedFailed) next.firstElementChild.insertAdjacentHTML('beforeend', '<div><span>' + (o.nestedPending ? 'Sending' : 'Not sent. Retry') + '</span></div>');
    if (o.statusLabel) next.firstElementChild.insertAdjacentHTML('beforeend', '<span aria-label="Not sent. Retry"></span>');
    if (o.hiddenStatus) next.firstElementChild.insertAdjacentHTML('beforeend', '<span hidden>Sending</span>');
    if (o.bodyStatusLabel) next.querySelector('span').insertAdjacentHTML('beforeend', '<i aria-label="Sending"></i>');
    if (o.bodyWrapper) next.querySelector('span').innerHTML = '<span>' + body + '</span>';
    if (o.pendingSettles) { next.insertAdjacentHTML('beforeend', '<span class="status">Sending</span>'); setTimeout(() => next.querySelector('.status').remove(), 40); }
    destination.append(next); if (o.doubleOutgoing) destination.append(next.cloneNode(true)); editor.textContent = '';
    if (o.lateFailure) setTimeout(() => next.insertAdjacentHTML('beforeend', '<span>Not sent. Retry</span>'), 120);
    if (o.lateNoAuth) setTimeout(() => document.querySelector('nav').remove(), 120);
    if (o.lateNetwork || o.lateHttp) setTimeout(() => fetch('/synthetic-transmission').catch(() => {}), 120);
    if (o.transmissionTick) setTimeout(() => window.fixtureEvent('transmission:alive'), 120);
    if (o.recipientAfterSend) scope.querySelector('a').href = '/100000000000002/';
  });
}
document.querySelector('#open').onclick = () => {
  window.fixtureEvent('open');
  if (o.unavailable || o.preopenedProfilePopup) return;
  if (o.preopenedRegionOnly) document.querySelector('#preexisting-region').remove();
  const show = () => {
    const scope = chat('target', o.wrongRecipient ? '100000000000002' : recipient, label);
    if (o.recovery) {
      const previous = row(!o.recoveryIncoming, o.recoveryMismatch ? 'Other message' : '  Synthetic \u00a0 message ', o.recoveryOld ? '4 November 2026, 20:14' : o.recoveryRelative ? 'Today, 20:16' : '4 November 2026, 20:16');
      if (!o.recoveryNoId) previous.firstElementChild.setAttribute('data-message-id', 'recovered-id');
      if (o.recoveryPending) previous.insertAdjacentHTML('beforeend', '<span>Sending</span>');
      if (o.recoveryDelayed) scope.fixtureRecovery = previous; else region(scope).append(previous);
      if (o.recoveryDuplicate) region(scope).append(previous.cloneNode(true));
    }
    if (o.scrollHistory) {
      const log = region(scope); log.style.cssText = 'height: 60px; overflow: auto';
      const spacer = document.createElement('div'); spacer.style.height = '600px'; log.append(spacer);
      if (o.virtualizedHistory) log.append(row());
      log.addEventListener('scroll', () => { if (log.scrollTop > 0) {
        window.fixtureEvent('history:tail');
        if (o.virtualizedHistory && !scope.fixtureVirtualized) {
          scope.fixtureVirtualized = true;
          const loading = document.createElement('div'); loading.setAttribute('role', 'progressbar'); log.append(loading);
          setTimeout(() => { log.replaceChildren(spacer, row(true, 'Earlier unrelated outgoing')); window.fixtureEvent('history:ready'); }, 90);
        }
        if (scope.fixtureRecovery) { const previous = scope.fixtureRecovery; delete scope.fixtureRecovery; setTimeout(() => log.append(previous), 90); }
      } });
    }
    if (o.prependHistory) region(scope).append(row(!o.inboundHistoryOnly, 'Earlier unrelated history'));
    if (o.identifyHistory) { const historical = row(); historical.firstElementChild.removeAttribute('data-message-id'); region(scope).append(historical); }
    if (o.oldOnly || o.sameTimestamp || o.rerenderAfterSend) region(scope).append(row());
    if (o.saturatedCounts) for (let i = 0; i < 100; i++) region(scope).append(row());

    document.querySelector('#chats').append(scope); wire(scope);
    if (o.historySpinner) historySpinner(scope, 'first_lookup');
    if (o.secondPopup || o.secondPopupHeaderOnly) {
      const other = chat('neighbour', '100000000000002', 'Other Recipient'); scope.after(other);
      if (o.secondPopupHeaderOnly) while (other.children[1]) other.children[1].remove(); else wire(other);
    }
    if (o.noSettingsLabel) scope.querySelector('[aria-label="Chat settings"]').removeAttribute('aria-label');
    if (o.headerProfilePhp) scope.querySelector('a').href = '/profile.php?id=' + recipient;
    if (o.outsideProfileLink) {
      const layout = document.createElement('div'); document.querySelector('#chats').replaceWith(layout);
      layout.innerHTML = '<a href="/100000000000001/">' + label + '</a>';
      const chats = document.createElement('div'); chats.id = 'chats'; layout.append(chats); chats.append(scope);
      scope.querySelector('a').replaceWith(document.createTextNode(label));
    }
    if (o.outsideProfileHeader) {
      const layout = document.createElement('div'); scope.replaceWith(layout);
      const profileHeader = chat('profile', recipient, label).firstElementChild;
      layout.append(profileHeader, scope);
    }
    if (o.duplicateRegion) scope.append(region(scope).cloneNode(true));
    if (o.duplicateComposer) scope.append(scope.querySelector('[aria-label="Thread composer"]').cloneNode(true));
    if (o.outsideHeaderLink) scope.append(scope.querySelector('a'));
    if (o.headerLinkInMessages) region(scope).append(scope.querySelector('a'));
    if (o.globalLinkOnly) { scope.querySelector('a').remove(); document.querySelector('nav').insertAdjacentHTML('beforeend', '<a href="/' + recipient + '/">' + label + '</a>'); }
    if (o.draft || o.sameDraft) scope.querySelector('[contenteditable]').textContent = o.draftWhitespace ? '  Earlier \u00a0 draft  ' : o.sameDraft ? body : 'Existing draft';
    const editor = scope.querySelector('[contenteditable]');
    if (o.emptyLexicalBreak) editor.innerHTML = '<p><br></p>';
    if (o.noEditor) editor.remove();
    if (o.hiddenEditor) editor.hidden = true;
    if (o.displayEditor) editor.style.display = 'none';
    if (o.inertEditor) editor.inert = true;
    if (o.noRegion) region(scope).remove();
    if (o.hiddenRegion) region(scope).hidden = true;
    if (o.nameMismatch) region(scope).setAttribute('aria-label', 'Messages in conversation with Different Name');
    if (o.noComposerScope) { editor.parentElement.removeAttribute('aria-label'); editor.removeAttribute('aria-placeholder'); }
    if (o.forbiddenScope) { const aside = document.createElement('aside'); scope.replaceWith(aside); aside.append(scope); }
    if (o.duplicateHeader) scope.prepend(scope.firstElementChild.cloneNode(true));
    if (o.zeroHeaders) { for (const button of scope.querySelectorAll('button, [role="button"]')) button.remove(); }
    if (o.wrappedNoHeader) { for (const button of scope.firstElementChild.querySelectorAll('button, [role="button"]')) button.remove(); }
    if (o.duplicateTarget) scope.after(scope.cloneNode(true));
    if (o.manyEditors) { for (let i = 0; i < 15; i++) scope.append(editor.cloneNode(true)); }
    if (o.hiddenLink) scope.querySelector('a').hidden = true;
    if (o.privacy) {
      const name = 'PRIVATE_NAME_SENTINEL';
      scope.querySelector('a').href = 'https://www.facebook.com/PRIVATE_HANDLE_SENTINEL/?token=PRIVATE_TOKEN_SENTINEL';
      scope.querySelector('a').textContent = name;
      editor.setAttribute('aria-label', 'Write to ' + name);
      region(scope).setAttribute('aria-label', 'Messages in conversation with ' + name);
      document.cookie = 'session=PRIVATE_COOKIE_SENTINEL';
      scope.setAttribute('data-private', 'private@example.invalid +12345678901 PRIVATE_MESSAGE_SENTINEL');
      scope.style.setProperty('--private', 'PRIVATE_CSS_SENTINEL');
    }
    if (o.wrappedChatBody) {
      const content = scope.lastElementChild;
      if (o.parentControls) region(scope).append(scope.querySelector('[aria-label="Chat settings"]').cloneNode(true));
      // A missing parent is not reachable in a static connected DOM; simulate
      // that observation without changing layout/visibility or the finder.
      if (o.parentMissing) Object.defineProperty(content, 'parentElement', { value: null });
      if (o.parentBody) document.body.append(content);
      if (o.parentChildren) {
        for (let i = 0; i < 15; i++) { const child = document.createElement('div'); child.textContent = 'PRIVATE_CHILD_SENTINEL'; scope.append(child); }
      }
      const header = scope.firstElementChild;
      if (o.parentRegions) header.append(region(scope).cloneNode(true));
      if (o.parentEditors) header.append(editor.cloneNode(true));
      if (o.parentForbidden) {
        for (let i = 0; i < 15; i++) { const aside = document.createElement('aside'); aside.textContent = 'PRIVATE_ASIDE_SENTINEL'; header.append(aside); }
      }
      if (o.parentHiddenExtras) {
        for (const node of [region(scope).cloneNode(true), editor.cloneNode(true), document.createElement('aside')]) {
          node.hidden = true; scope.append(node);
        }
      }
    }
    if (o.directPage) history.replaceState(null, '', '/messages/t/SYNTHETIC_PRIVATE_THREAD/');
    // Synthetic third branch: Sonar86 exposed only its count, not its contents.
    if (o.incidentalBranch || Object.keys(o).some(key => key.startsWith('extraBranch'))) {
      const extra = document.createElement('div');
      extra.innerHTML = '<span role="status">Synthetic chat notice</span>';
      if (o.extraBranchHeader) extra.append(scope.firstElementChild.cloneNode(true));
      if (o.extraBranchProfile || o.extraBranchOtherRecipient || o.extraBranchBorrowedProfile) {
        const link = scope.querySelector('a').cloneNode(true);
        if (o.extraBranchOtherRecipient) link.href = '/100000000000002/';
        extra.append(link);
        if (o.extraBranchBorrowedProfile) scope.querySelector('a').remove();
      }
      if (o.extraBranchChat) extra.append(chat('embedded', '100000000000002', 'Other Recipient'));
      if (o.extraBranchEditor) {
        const other = editor.cloneNode(true); other.removeAttribute('data-lexical-editor'); extra.append(other);
      }
      if (o.extraBranchRegion) extra.append(region(scope).cloneNode(true));
      if (o.extraBranchLog) extra.insertAdjacentHTML('beforeend', '<div role="log">Other conversation</div>');
      if (o.extraBranchComposer) {
        const other = scope.querySelector('[aria-label="Thread composer"]').cloneNode(true);
        other.querySelector('[contenteditable]').remove(); extra.append(other);
      }
      if (o.extraBranchControl) extra.insertAdjacentHTML('beforeend', '<button>Close chat</button>');
      if (o.extraBranchSend) extra.insertAdjacentHTML('beforeend', '<button aria-label="Press Enter to send">Send</button>');
      if (o.extraBranchLike) extra.insertAdjacentHTML('beforeend', '<button aria-label="Send a Like">Like</button>');
      if (o.extraBranchNav) extra.insertAdjacentHTML('beforeend', '<nav>Other navigation</nav>');
      if (o.extraBranchContentProfile) scope.querySelector('[aria-label="Thread composer"]').after(scope.querySelector('a').cloneNode(true));
      if (o.extraBranchDuplicateControl) scope.firstElementChild.append(scope.querySelector('[aria-label="Chat settings"]').cloneNode(true));
      scope.append(extra);
    }
    if (o.otherPage) history.replaceState(null, '', '/unrecognized/synthetic/');
    if (o.afterFillNoAuth) editor.addEventListener('input', () => document.querySelector('nav').remove(), { once: true });
    if (o.afterFillNoRegion) editor.addEventListener('input', () => region(scope).remove(), { once: true });
    if (o.afterFillHiddenButton) editor.addEventListener('input', () => scope.querySelector('[aria-label="Press Enter to send"]').hidden = true, { once: true });
    if (o.afterFillExtraHeader) editor.addEventListener('input', () => scope.append(scope.firstElementChild.cloneNode(true)), { once: true });
  };
  if (o.delayedChat) setTimeout(show, 40); else show();
};
if (o.headerNameButton) document.querySelector('main h1').textContent = '  Synthetic   Recipient  ';
if (o.preopenedRegionOnly) document.querySelector('#chats').innerHTML = '<div id="preexisting-region" role="log">Existing conversation</div>';
if (o.preopenedProfilePopup) { const scope = chat('target', recipient, label); document.querySelector('#chats').append(scope); wire(scope); }
if (o.neighbour) { const other = chat('neighbour', '100000000000002', 'Other Recipient'); document.querySelector('#chats').append(other); wire(other); }
if (o.checkpoint) document.body.insertAdjacentHTML('beforeend', '<form action="/checkpoint/"><button>Continue</button></form>');
if (o.noAction) document.querySelector('#open').remove();
</script>`;

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Facebook observed floating chat contract',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    async function fixture(options: Record<string, boolean | undefined> = {}) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addCookies([
        {
          name: 'c_user',
          value: '100000000000009',
          domain: '.facebook.com',
          path: '/',
        },
      ]);
      let page: Page;
      context.on('page', (value) => {
        page = value;
        if (options.evaluateError)
          vi.spyOn(page, 'evaluateHandle').mockRejectedValueOnce(
            Error('PRIVATE_ERROR_SENTINEL private@example.invalid'),
          );
        if (options.lateDom || options.acquireRace) {
          const wait = page.waitForFunction.bind(page);
          vi.spyOn(page, 'waitForFunction').mockImplementation(
            async (...args) => {
              try {
                const result = await wait(...args);
                if (options.acquireRace)
                  await page.evaluate(() =>
                    document
                      .querySelector('#target [contenteditable]')
                      ?.remove(),
                  );
                return result;
              } catch (error) {
                await page.evaluate(() =>
                  document.querySelector('#chats')?.replaceChildren(),
                );
                throw error;
              }
            },
          );
        }
      });
      const events: string[] = [];
      const dispatchPhases: string[] = [];
      const popupChildren: number[] = [];
      const requests: string[] = [];
      const target = options.company
        ? 'https://www.facebook.com/synthetic_company/'
        : 'https://www.facebook.com/profile.php?id=100000000000001';
      await context.exposeBinding('fixtureEvent', (_source, event: string) => {
        events.push(event);
      });
      await context.exposeBinding(
        'fixtureDispatch',
        (_source, phase: string) => {
          dispatchPhases.push(phase);
        },
      );
      await context.addInitScript({
        content: `window.fixtureOptions = ${JSON.stringify(options)}`,
      });
      let marked = false;
      await context.route('**/*', (route) => {
        requests.push(route.request().url());
        if (options.background && route.request().url().endsWith('/background'))
          return;
        if (
          options.lateHttp &&
          route.request().url().endsWith('/synthetic-transmission')
        )
          return route.fulfill({ status: 503, body: 'Synthetic failure' });
        if (route.request().url() !== target)
          return route.abort('blockedbyclient');
        if (options.networkAbort || (marked && options.markerNetwork))
          return route.abort('connectionrefused');
        const status =
          options.rateLimit || (marked && options.markerRateLimit)
            ? 429
            : options.serviceUnavailable || (marked && options.marker503)
              ? 503
              : options.proxyFailure
                ? 407
                : 200;
        return route.fulfill({
          contentType: 'text/html',
          status,
          body:
            status >= 400 || options.noAuth
              ? '<h1>Service unavailable</h1>'
              : options.login
                ? '<input type="password">'
                : (options.noH1
                    ? markup.replace(
                        '<h1>Synthetic recipient</h1>',
                        options.noTitle
                          ? ''
                          : '<a href="/100000000000001/" aria-label="Synthetic Recipient"></a><div role="button" aria-label="Add friend Synthetic Recipient"></div>',
                      )
                    : markup) +
                  (options.stalledNavigation
                    ? '<script defer src="/background"></script>'
                    : '') +
                  (options.background
                    ? '<img src="/background"><script>setInterval(() => fetch("/background"), 20)</script>'
                    : ''),
        });
      });
      const adapter = createSocialSendBrowser(
        async () => ({ newContext: async () => context }) as unknown as Browser,
      );
      const persistDraft = vi.fn(async () => {
        if (options.draftPersistenceFailure)
          throw Error('synthetic persistence failure');
      });
      const mark = vi.fn(async () => {
        events.push('mark');
        if (options.headerNameButton)
          popupChildren.push(await page.locator('#target > *').count());
        marked = true;
        if (
          options.markerNetwork ||
          options.marker503 ||
          options.markerRateLimit
        )
          await page.goto(target).catch(() => {});
        if (
          options.clickStable ||
          Object.keys(options).some((key) => key.startsWith('click')) ||
          options.documentCaptureRecipient
        )
          await page.evaluate((options) => {
            const scope = document.querySelector('#target')!;
            const button = scope.querySelector(
              '[aria-label="Press Enter to send"]',
            )!;
            const mutate = (event: Event) => {
              void (
                window as unknown as {
                  fixtureDispatch: (phase: string) => Promise<void>;
                }
              ).fixtureDispatch(event.type);
              const editor = scope.querySelector('[contenteditable]')!;
              if (options.clickHeaderName)
                scope.querySelector('[data-fixture-recipient]')!.textContent =
                  'Other Recipient';
              if (options.clickSecondPopup) scope.after(scope.cloneNode(true));
              if (options.clickRecipient || options.documentCaptureRecipient) {
                scope
                  .querySelector('a')!
                  .setAttribute('href', '/100000000000002/');
                scope.querySelector('a')!.textContent = 'Other Recipient';
                editor.setAttribute('aria-label', 'Write to Other Recipient');
                scope
                  .querySelector('[aria-label^="Messages in conversation"]')!
                  .setAttribute(
                    'aria-label',
                    'Messages in conversation with Other Recipient',
                  );
              }
              if (options.clickComposer)
                editor.replaceWith(editor.cloneNode(true));
              if (options.clickBody) editor.textContent = 'Changed draft';
              if (options.clickButton)
                button.replaceWith(button.cloneNode(true));
              if (options.clickDuplicateButton)
                button.after(button.cloneNode(true));
              if (options.clickDisabled)
                button.setAttribute('aria-disabled', 'true');
              if (options.clickReparent) scope.append(button);
              if (options.clickAvatarLabel)
                scope
                  .querySelector('a')!
                  .setAttribute('aria-label', 'Other Recipient');
              if (options.clickChatBodyReparent)
                scope.append(
                  scope.querySelector('[aria-label="Thread composer"]')!,
                );
              if (options.clickExtraHeader)
                scope.append(scope.firstElementChild!.cloneNode(true));
              if (options.clickExtraProfile)
                scope.append(scope.querySelector('a')!.cloneNode(true));
              if (options.clickExtraControl)
                scope.insertAdjacentHTML(
                  'beforeend',
                  '<button>Close chat</button>',
                );
              if (options.clickExtraEditor)
                scope.insertAdjacentHTML(
                  'beforeend',
                  '<div role="textbox">Other editor</div>',
                );
              if (options.clickExtraLog)
                scope.insertAdjacentHTML(
                  'beforeend',
                  '<div role="log">Other conversation</div>',
                );
              if (options.clickIncidental)
                scope.insertAdjacentHTML(
                  'beforeend',
                  '<div role="status">Synthetic notice</div>',
                );
            };
            // Synchronize with the real dispatch after the guard is armed.
            // An animation plus a timer does not guarantee mutation before click.
            // Document capture runs between the window and scope/button guards.
            document.addEventListener(
              options.documentCaptureRecipient || options.documentCaptureButton
                ? 'click'
                : 'pointerdown',
              mutate,
              {
                capture: true,
                once: true,
              },
            );
          }, options);
        if (options.markerOutgoing)
          await page.evaluate(() => {
            const region = document.querySelector(
              '#target [aria-label^="Messages in conversation"]',
            )!;
            region.append(region.firstElementChild!.cloneNode(true));
          });
        if (options.markerFailure)
          throw Error('PRIVATE_ERROR_SENTINEL private@example.invalid');
        if (options.markerClose) await page.close();
        if (options.markerCheckpoint)
          await page.evaluate(() =>
            document.body.insertAdjacentHTML(
              'beforeend',
              '<form action="/checkpoint/"><button>Continue</button></form>',
            ),
          );
        if (options.markerUrl)
          await page.evaluate(() =>
            history.replaceState(null, '', '/PRIVATE_URL_SENTINEL/'),
          );
        if (options.markerRecipient)
          await page.evaluate(() => {
            document.querySelector<HTMLAnchorElement>('#target a')!.href =
              '/100000000000002/';
          });
        if (options.markerHeaderName || options.markerSecondPopup)
          await page.evaluate((options) => {
            const scope = document.querySelector('#target')!;
            if (options.markerHeaderName)
              scope.querySelector('[data-fixture-recipient]')!.textContent =
                'Other Recipient';
            if (options.markerSecondPopup) scope.after(scope.cloneNode(true));
          }, options);
        if (options.markerExtraHeader)
          await page.evaluate(() => {
            const scope = document.querySelector('#target')!;
            scope.append(scope.firstElementChild!.cloneNode(true));
          });
        if (options.markerRerender)
          await page.evaluate(() => {
            const scope = document.querySelector('#target')!;
            scope.replaceWith(scope.cloneNode(true));
          });
        if (options.markerComposer)
          await page.evaluate(() => {
            const editor = document.querySelector('#target [contenteditable]')!;
            editor.replaceWith(editor.cloneNode(true));
          });
        if (options.markerBody)
          await page.evaluate(() => {
            document.querySelector('#target [contenteditable]')!.textContent =
              'Different text';
          });
      });
      return {
        events,
        dispatchPhases,
        popupChildren,
        requests,
        mark,
        persistDraft,
        target,
        send: () =>
          adapter.send(
            { id: 'synthetic', channel: 'facebook', settings: {} },
            { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
            options.saturatedCounts ? 2000 : 400,
            target,
            options.whitespaceBody
              ? 'Synthetic  message'
              : options.multilineBody
                ? 'Synthetic\nmessage'
                : options.bodySending
                  ? 'Sending'
                  : options.bodyPending
                    ? 'Pending review'
                    : 'Synthetic message',
            mark,
            options.ownDraft ||
              options.priorDraft ||
              options.foreignDraft ||
              options.draftPersistenceFailure ||
              options.recovery
              ? {
                  recoveryFirstAttemptAt: options.recovery
                    ? '2026-11-04T20:15:00Z'
                    : undefined,
                  previousBodies: options.priorDraft ? ['Earlier draft'] : [],
                  previousBody: options.ownDraft
                    ? 'Synthetic message'
                    : undefined,
                  beforeFill: persistDraft,
                }
              : undefined,
          ),
        close: () => context.close(),
      };
    }
    it('confirms delivery from message structure alone, in an unknown language', async () => {
      const f = await fixture({ structuralOnly: true });
      try {
        await expect(f.send()).resolves.toBeTruthy();
        expect(f.events).toContain('send:target');
      } finally {
        await f.close();
      }
    });

    it('confirms delivery from Ukrainian outgoing message labels', async () => {
      const f = await fixture({ ukLabels: true });
      try {
        await expect(f.send()).resolves.toBeTruthy();
        expect(f.events).toContain('send:target');
      } finally {
        await f.close();
      }
    });

    it.each([false, true])(
      'does not confirm old matching history prepended after dispatch (inbound-only: %s)',
      async (inboundHistoryOnly) => {
        const f = await fixture({ prependHistory: true, inboundHistoryOnly });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
          });
        } finally {
          await f.close();
        }
      },
    );

    it('does not confirm an existing ID-less structural row when its ID hydrates after dispatch', async () => {
      const f = await fixture({ structuralOnly: true, identifyHistory: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'delivery_uncertain',
        });
        expect(
          f.events.filter((event) => event === 'send:target'),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it.each([false, true])(
      'counts existing outgoing messages with bodies different from the new draft (quoted uk: %s)',
      async (quotedUk) => {
        const f = await fixture({ observed: true, quotedUk });
        try {
          expect(await f.send()).toMatchObject({
            observation: {
              outgoingBefore: 2,
              outgoingAfter: 3,
              newOutgoing: true,
            },
          });
          expect(
            f.events.filter((event) => event === 'send:target'),
          ).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
    );

    it('sends from a profile without h1 when the add-friend action and a profile link carry the same name', async () => {
      const f = await fixture({ noH1: true });
      try {
        await expect(f.send()).resolves.toBeTruthy();
        expect(f.events).toContain('send:target');
      } finally {
        await f.close();
      }
    });

    it('does not send from a profile with neither h1 nor an add-friend title', async () => {
      const f = await fixture({ noH1: true, noTitle: true });
      try {
        await expect(f.send()).rejects.toBeTruthy();
        expect(f.events).not.toContain('send:target');
      } finally {
        await f.close();
      }
    });

    it.each([{ headerNameButton: true }, { observed: true }])(
      'reuses a confirmed existing profile mini-chat (%j)',
      async (options) => {
        const f = await fixture({ ...options, preopenedProfilePopup: true });
        try {
          await expect(f.send()).resolves.toBeTruthy();
          expect(f.events).not.toContain('open');
          expect(f.events).toContain('send:target');
          expect(f.events).not.toContain('call');
        } finally {
          await f.close();
        }
      },
    );
    it('closes another mini-chat only through its close control, then opens the recipient', async () => {
      const f = await fixture({ neighbour: true, headerNameButton: true });
      try {
        await expect(f.send()).resolves.toBeTruthy();
        expect(f.events.indexOf('close:neighbour')).toBeLessThan(
          f.events.indexOf('open'),
        );
        expect(f.events).not.toContain('call');
        expect(f.events).not.toContain('send:neighbour');
      } finally {
        await f.close();
      }
    });
    it('blocks a close control changed to a call during pointer dispatch', async () => {
      const f = await fixture({ neighbour: true, closeMutatesToCall: true });
      try {
        await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.events).not.toContain('call');
        expect(f.events).not.toContain('open');
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'reconciles an exact normalized outgoing after the prior attempt without filling or sending (delayed: %s)',
      async (delayed) => {
        const f = await fixture({
          recovery: true,
          recoveryDelayed: delayed,
          scrollHistory: delayed,
        });
        try {
          await expect(f.send()).resolves.toMatchObject({
            outcome: 'facebook_reconciled',
            externalMessageId: 'recovered-id',
            observation: {
              dispatchPerformed: false,
              matchedOutgoingAt: '2026-11-04T20:16:00.000Z',
            },
          });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.persistDraft).not.toHaveBeenCalled();
          expect(
            f.events.filter((event) => /^(?:send|input):/.test(event)),
          ).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      'recoveryOld',
      'recoveryIncoming',
      'recoveryMismatch',
      'recoveryPending',
      'recoveryNoId',
      'recoveryRelative',
      'recoveryDuplicate',
    ])('fails closed for inconclusive prior delivery: %s', async (option) => {
      const f = await fixture({ recovery: true, [option]: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'delivery_uncertain',
        });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.persistDraft).not.toHaveBeenCalled();
        expect(
          f.events.filter((event) => /^(?:send|input):/.test(event)),
        ).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'positions scrolled and virtualized history at the latest bubbles before counting (virtualized: %s)',
      async (virtualized) => {
        const f = await fixture({
          scrollHistory: true,
          virtualizedHistory: virtualized,
        });
        try {
          await expect(f.send()).resolves.toBeTruthy();
          expect(f.events).toContain('history:tail');
          if (virtualized)
            expect(f.events.indexOf('history:ready')).toBeLessThan(
              f.events.indexOf('mark'),
            );
        } finally {
          await f.close();
        }
      },
    );
    it('does not confirm two matching outgoing bubbles from one dispatch', async () => {
      const f = await fixture({ doubleOutgoing: true });
      try {
        await expect(f.send()).rejects.toMatchObject({
          code: 'delivery_uncertain',
        });
        expect(f.mark).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'uses the rendered profile while load/background requests remain pending (deferred script: %s)',
      async (stalledNavigation) => {
        const f = await fixture({ background: true, stalledNavigation });
        try {
          await expect(f.send()).resolves.toBeTruthy();
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.requests.some((url) => url.endsWith('/background'))).toBe(
            true,
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      [
        { noEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { editors: { raw: 0, visible: 0, visibility: 'absent' } },
      ],
      [
        { hiddenEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { editors: { raw: 1, visible: 0, visibility: 'hidden' } },
      ],
      [
        { displayEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { editors: { raw: 1, visible: 0, visibility: 'display' } },
      ],
      [
        { inertEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { editors: { raw: 1, visible: 0, visibility: 'inert' } },
      ],
      [
        { noRegion: true },
        'first_lookup',
        'no_region',
        'timeout',
        { regions: { raw: 0, visible: 0, visibility: 'absent' } },
      ],
      [
        { hiddenRegion: true },
        'first_lookup',
        'no_region',
        'timeout',
        { regions: { raw: 1, visible: 0, visibility: 'hidden' } },
      ],
      [
        { duplicateRegion: true },
        'first_lookup',
        'multiple',
        'timeout',
        { regions: { raw: 2, visible: 2 } },
      ],
      [
        { manyEditors: true },
        'first_lookup',
        'multiple',
        'timeout',
        { editors: { raw: 9, visible: 9 } },
      ],
      [
        { duplicateTarget: true },
        'first_lookup',
        'multiple',
        'timeout',
        { candidates: 2 },
      ],
      [{ forbiddenScope: true }, 'first_lookup', 'forbidden', 'timeout', {}],
      [{ nameMismatch: true }, 'first_lookup', 'name_mismatch', 'timeout', {}],
      [
        { noComposerScope: true },
        'first_lookup',
        'composer_scope',
        'timeout',
        {},
      ],
      [
        { duplicateHeader: true },
        'first_lookup',
        'header_count',
        'timeout',
        { headers: 2 },
      ],
      [{ zeroHeaders: true }, 'first_lookup', 'header_count', 'timeout', {}],
      ...(
        [
          [
            { parentControls: true, parentMissing: true },
            { subreason: 'content_controls' },
          ],
          [{ parentMissing: true }, { subreason: 'parent_missing' }],
          [{ parentBody: true }, { subreason: 'parent_body' }],
          [
            { parentChildren: true, parentRegions: true },
            {
              subreason: 'parent_regions',
              childrenVisible: 9,
              regionsVisible: 2,
            },
          ],
          [
            { parentRegions: true, parentEditors: true },
            {
              subreason: 'parent_regions',
              childrenVisible: 2,
              regionsVisible: 2,
            },
          ],
          [
            { parentEditors: true, parentForbidden: true },
            {
              subreason: 'parent_editors',
              childrenVisible: 2,
              regionsVisible: 1,
              editorsVisible: 2,
            },
          ],
          [
            { parentForbidden: true },
            {
              subreason: 'parent_forbidden',
              childrenVisible: 2,
              regionsVisible: 1,
              editorsVisible: 1,
              forbiddenVisible: 9,
            },
          ],
        ] as const
      ).map(
        ([options, parentStructure]) =>
          [
            { ...options, wrappedChatBody: true, privacy: true },
            'first_lookup',
            'parent_structure',
            'timeout',
            { parentStructure },
          ] as const,
      ),
      [
        { wrappedChatBody: true, wrappedNoHeader: true },
        'first_lookup',
        'header_count',
        'timeout',
        { headers: 0 },
      ],
      [
        { globalLinkOnly: true },
        'first_lookup',
        'recipient_link_count',
        'timeout',
        { hasRecipientLink: false, canonicalMatch: false, nameMatch: false },
      ],
      [
        { hiddenLink: true },
        'first_lookup',
        'recipient_link_count',
        'timeout',
        { links: { raw: 1, visible: 0, visibility: 'hidden' } },
      ],
      [
        { avatarLink: true, wrongAvatarLabel: true },
        'first_lookup',
        'recipient_link_count',
        'timeout',
        { hasRecipientLink: true, canonicalMatch: true, nameMatch: false },
      ],
      [
        { wrongRecipient: true },
        'first_lookup',
        'wrong_recipient',
        'timeout',
        { hasRecipientLink: true, canonicalMatch: false, nameMatch: true },
      ],
      [
        { wrongRecipient: true, lateDom: true },
        'first_lookup',
        'wrong_recipient',
        'timeout',
        { links: { raw: 1, visible: 1 } },
      ],
      [
        { privacy: true },
        'first_lookup',
        'wrong_recipient',
        'timeout',
        { nameMatch: true },
      ],
      [{ draft: true }, 'first_lookup', 'draft', 'not_found', {}],
      [{ afterFillNoRegion: true }, 'after_fill', 'no_region', 'timeout', {}],
      [
        { observed: true, afterFillExtraHeader: true },
        'after_fill',
        'header_count',
        'timeout',
        { headers: 2 },
      ],
      [
        { afterFillHiddenButton: true },
        'after_fill',
        'invalidated',
        'not_found',
        { buttons: { raw: 1, visible: 0, visibility: 'hidden' } },
      ],
      [
        { markerRecipient: true },
        'after_marker',
        'invalidated',
        'not_found',
        { canonicalMatch: false },
      ],
      [{ markerFailure: true }, 'after_marker', 'bound', 'unknown', {}],
      [{ clickDisabled: true }, 'dispatch', 'invalidated', 'not_found', {}],
      [
        { clickButton: true, documentCaptureButton: true },
        'dispatch',
        'dispatch_blocked',
        'not_found',
        {},
      ],
      [{ oldOnly: true }, 'confirmation', 'unconfirmed', 'timeout', {}],
      [
        { rerenderAfterSend: true },
        'confirmation',
        'baseline_invalidated',
        'timeout',
        {},
      ],
      [{ evaluateError: true }, 'first_lookup', 'not_observed', 'unknown', {}],
      [
        { afterFillNoAuth: true },
        'before_marker',
        'session_check',
        'not_found',
        {},
      ],
      [{ markerUrl: true }, 'after_marker', 'url_changed', 'not_found', {}],
      [
        { acquireRace: true },
        'first_lookup',
        'no_editor',
        'not_found',
        { editors: { raw: 0, visible: 0 } },
      ],
      [
        { directPage: true, noEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { pageKind: 'direct' },
      ],
      [
        { otherPage: true, noEditor: true },
        'first_lookup',
        'no_editor',
        'timeout',
        { pageKind: 'other' },
      ],
    ] as const)(
      'reports the exact private observation (%j)',
      async (options, phase, branch, failure, detail) => {
        const f = await fixture(options);
        try {
          const error = (await f.send().catch((error: unknown) => error)) as {
            code: string;
            reasonUk: string;
          };
          expect(error.code).toBe(
            ['after_marker', 'dispatch', 'confirmation'].includes(phase)
              ? 'delivery_uncertain'
              : 'unavailable',
          );
          const diagnostic = JSON.parse(
            error.reasonUk.slice(error.reasonUk.indexOf('{')),
          );
          expect(diagnostic).toMatchObject({
            version: 'fb-profile-chat-v2',
            phase,
            branch,
            failure,
            ...detail,
          });
          if ('parentStructure' in detail)
            expect(diagnostic.parentStructure).toEqual(detail.parentStructure);
          if (
            !('evaluateError' in options) &&
            !('directPage' in options) &&
            !('otherPage' in options)
          )
            expect(diagnostic.pageKind).toBe('profile');
          expect(error.reasonUk).not.toMatch(
            /PRIVATE_|private@example|12345678901|10000000000000|Synthetic|SYNTHETIC_PRIVATE|https?:|href|aria-label/,
          );
          const scalars = (value: unknown): unknown[] =>
            value && typeof value === 'object'
              ? Object.values(value).flatMap(scalars)
              : [value];
          for (const value of scalars({
            ...diagnostic,
            transmission: undefined,
          }))
            if (typeof value === 'number') {
              expect(value).toBeGreaterThanOrEqual(0);
              expect(value).toBeLessThanOrEqual(9);
            }
          expect(f.mark).toHaveBeenCalledTimes(
            ['after_marker', 'dispatch', 'confirmation'].includes(phase)
              ? 1
              : 0,
          );
          if (branch === 'parent_structure') expect(f.events).toEqual(['open']);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { headerNameButton: true },
      { headerNameButton: true, decoratedHeader: true },
      {
        headerNameButton: true,
        decoratedHeader: true,
        normalizedIdentityLabels: true,
      },
      { headerNameButton: true, decoratedHeader: true, rerenderFill: true },
      { headerNameButton: true, headerSpan: true, lexicalWrap: true },
      { headerNameButton: true, headerSpan: true, headerAvatar: true },
      {
        headerNameButton: true,
        headerLink: true,
        lexicalWrap: true,
        ukrainianRestore: true,
      },
      { headerNameButton: true, lexicalNewline: true },
      { headerNameButton: true, emptyLexicalBreak: true },
      { headerNameButton: true, whitespaceBody: true },
      { headerNameButton: true, multilineBody: true },
      { headerNameButton: true, sameDraft: true, ownDraft: true },
      { headerNameButton: true, company: true },
      { observed: true, incidentalBranch: true },
      { observed: true, incidentalBranch: true, neighbour: true },
      { observed: true, incidentalBranch: true, pendingSettles: true },
      { wrappedChatBody: true, incidentalBranch: true },
      { wrappedChatBody: true, parentChildren: true },
      { observed: true, clickIncidental: true },
      { observed: true },
      { observed: true, company: true },
      { observed: true, neighbour: true },
      { observed: true, sameTimestamp: true },
      { observed: true, saturatedCounts: true },
      { observed: true, bodySending: true },
      { observed: true, pendingSettles: true },
      {},
      { company: true },
      { noSettingsLabel: true },
      { neighbour: true },
      { headerProfilePhp: true },
      { delayedChat: true, neighbour: true },
      { rerenderFill: true },
      { sameTimestamp: true },
      { bodyPending: true },
      { pendingSettles: true },
      { bodySending: true },
      { bodySending: true, bodyWrapper: true },
      { hiddenStatus: true },
      { clickStable: true },
      { avatarLink: true },
      { avatarLink: true, company: true },
      { avatarLink: true, headerProfilePhp: true },
      { wrappedChatBody: true },
      { wrappedChatBody: true, parentHiddenExtras: true },
      { avatarLink: true, wrappedChatBody: true, neighbour: true },
      { avatarLink: true, wrappedChatBody: true, company: true },
      { e2eeAa: true },
    ])(
      'sends once to a bound direct profile/Page and confirms a distinct outgoing (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          const result = await f.send().catch((error: unknown) => {
            throw new Error(
              (error as { reasonUk?: string }).reasonUk ?? 'send failed',
            );
          });
          expect(result).toMatchObject({
            outcome: 'facebook_dispatched_unconfirmed',
            dialogUrl: f.target,
            observation: {
              inputExactMatch: true,
              dispatchPerformed: true,
              lateError: 'none',
            },
          });
          const inputEvents = f.events.filter(
            (event) => event === 'input:target',
          );
          expect(inputEvents.length).toBeGreaterThan(0);
          expect(f.events).toEqual([
            ...(options.neighbour ? ['close:neighbour'] : []),
            'open',
            ...inputEvents,
            'mark',
            'send:target',
          ]);
          if (options.saturatedCounts)
            expect(result).toMatchObject({
              observation: {
                outgoingBefore: 99,
                outgoingAfter: 99,
                newOutgoing: true,
              },
            });
          expect(f.mark).toHaveBeenCalledOnce();
          if (options.headerNameButton) expect(f.popupChildren).toEqual([3]);
          expect(f.requests).toEqual([f.target]);
          expect(f.dispatchPhases).toEqual(
            options.clickStable || options.clickIncidental
              ? ['pointerdown']
              : [],
          );
        } finally {
          await f.close();
        }
      },
      15000,
    );
    it.each(['first_lookup', 'after_fill'] as const)(
      'waits for mini-chat history before filling/marking (%s)',
      async (phase) => {
        const f = await fixture({
          headerNameButton: true,
          decoratedHeader: true,
          historySpinner: phase === 'first_lookup',
          afterFillSpinner: phase === 'after_fill',
        });
        try {
          await expect(f.send()).resolves.toMatchObject({
            outcome: 'facebook_dispatched_unconfirmed',
          });
          expect(f.events).toEqual([
            'open',
            ...(phase === 'first_lookup'
              ? ['history-ready:first_lookup', 'input:target']
              : ['input:target', 'history-ready:after_fill']),
            'mark',
            'send:target',
          ]);
          expect(f.requests).toEqual([f.target]);
        } finally {
          await f.close();
        }
      },
    );
    it.each(['first_lookup', 'after_fill'] as const)(
      'times out safely on persistent mini-chat history spinner (%s)',
      async (phase) => {
        const f = await fixture({
          headerNameButton: true,
          decoratedHeader: true,
          historySpinner: phase === 'first_lookup',
          afterFillSpinner: phase === 'after_fill',
          spinnerRemains: true,
        });
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'unavailable',
            reasonUk: expect.stringContaining('"branch":"history_loading"'),
          });
          expect(f.events).toEqual([
            'open',
            ...(phase === 'after_fill' ? ['input:target'] : []),
          ]);
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it.each([false, true])(
      'retains an observed provider ID only when present (%s)',
      async (stableMessageId) => {
        const f = await fixture({
          observed: true,
          noMessageId: !stableMessageId,
        });
        try {
          const result = await f.send();
          expect(result).toHaveProperty(
            'outcome',
            'facebook_dispatched_unconfirmed',
          );
          expect(
            (result as { externalMessageId?: string }).externalMessageId,
          ).toBe(stableMessageId ? 'synthetic-outgoing-101' : undefined);
        } finally {
          await f.close();
        }
      },
    );
    it('keeps the original page open for the bounded transmission period without claiming delivery', async () => {
      const f = await fixture({ observed: true, transmissionTick: true });
      try {
        const result = await f.send();
        expect(result).toMatchObject({
          outcome: 'facebook_dispatched_unconfirmed',
          observation: {
            senderFingerprint: createHash('sha256')
              .update('100000000000009')
              .digest('hex')
              .slice(0, 12),
            lateError: 'none',
          },
        });
        if (typeof result === 'string')
          throw Error('Unexpected verified result');
        expect(result.observation.outgoingAfter).toBeGreaterThan(
          result.observation.outgoingBefore,
        );
        expect(result.observation.observationMs).toBeGreaterThanOrEqual(400);
        expect(result.observation.observationMs).toBeLessThan(2000);
        expect(f.events).toContain('transmission:alive');
        expect(JSON.stringify(result)).not.toContain('100000000000009');
      } finally {
        await f.close();
      }
    });
    it.each(['lateFailure', 'lateNoAuth', 'lateNetwork', 'lateHttp'])(
      'observes %s before closing the original page',
      async (kind) => {
        const f = await fixture({ observed: true, [kind]: true });
        const started = Date.now();
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
            reasonUk: expect.stringContaining(
              `"lateError":"${kind === 'lateFailure' ? 'outgoing_changed' : kind === 'lateNetwork' ? 'network' : kind === 'lateHttp' ? 'http_error' : 'session'}"`,
            ),
          });
          expect(Date.now() - started).toBeLessThan(2000);
          expect(f.events.filter((event) => event.startsWith('send:'))).toEqual(
            ['send:target'],
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      'hiddenDraftText',
      'extraDraftParagraph',
      'emptyDraftParagraph',
      'splitDraftWords',
      'breakDraftWords',
    ])('rejects ambiguous Lexical text after fill (%s)', async (kind) => {
      const f = await fixture({
        headerNameButton: true,
        lexicalNewline: true,
        [kind]: true,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.events).toEqual(['open', 'input:target']);
        expect(f.mark).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
    it('rejects unsupported editor markup after filling without marking or sending', async () => {
      const f = await fixture({
        headerNameButton: true,
        unsupportedInline: true,
      });
      try {
        await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.mark).not.toHaveBeenCalled();
        expect(f.events).toEqual(['open', 'input:target']);
      } finally {
        await f.close();
      }
    });
    it('replaces a normalized draft from an earlier undelivered message', async () => {
      const f = await fixture({
        headerNameButton: true,
        draft: true,
        draftWhitespace: true,
        priorDraft: true,
      });
      try {
        await expect(f.send()).resolves.toMatchObject({
          outcome: 'facebook_dispatched_unconfirmed',
        });
        expect(f.mark).toHaveBeenCalledOnce();
        expect(f.events).not.toContain('restore');
      } finally {
        await f.close();
      }
    });
    it.each(['afterFillHeaderName', 'afterFillProfileName'])(
      'rejects a mini-chat recipient change after fill without marking (%s)',
      async (kind) => {
        const f = await fixture({
          headerNameButton: true,
          decoratedHeader: true,
          [kind]: true,
        });
        try {
          const error = await f.send().catch((error: unknown) => error);
          expect(error).toMatchObject({ code: 'unavailable' });
          expect((error as { reasonUk: string }).reasonUk).toContain(
            '"phase":"after_fill"',
          );
          expect((error as { reasonUk: string }).reasonUk).toContain(
            '"branch":"recipient_link_count"',
          );
          expect(f.events).toEqual(['open', 'input:target']);
          expect(f.mark).not.toHaveBeenCalled();
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      {
        headerNameButton: true,
        decoratedHeader: true,
        headerWrongParentLabel: true,
      },
      {
        headerNameButton: true,
        decoratedHeader: true,
        duplicateHeaderName: true,
      },
      { headerNameButton: true, headerWrongParentLabel: true },
      { headerNameButton: true, headerNameMismatch: true },
      { headerNameButton: true, headerSpan: true, headerNameMismatch: true },
      {
        headerNameButton: true,
        headerSpan: true,
        headerAvatar: true,
        wrongAvatarLabel: true,
      },
      {
        headerNameButton: true,
        headerSpan: true,
        headerAvatar: true,
        wrongAvatarText: true,
      },
      {
        headerNameButton: true,
        headerSpan: true,
        headerAvatar: true,
        wrongAvatarRecipient: true,
      },
      { headerNameButton: true, headerLink: true, wrongRecipient: true },
      { headerNameButton: true, lexicalWrap: true, extraBranchSend: true },
      { headerNameButton: true, sameDraft: true, foreignDraft: true },
      { headerNameButton: true, draft: true, ownDraft: true },
      { headerNameButton: true, draftPersistenceFailure: true },
      { headerNameButton: true, secondPopup: true },
      { headerNameButton: true, secondPopupHeaderOnly: true },
      { headerNameButton: true, preopenedRegionOnly: true },
      { headerNameButton: true, directPage: true },
      ...[
        'extraBranchHeader',
        'extraBranchProfile',
        'extraBranchOtherRecipient',
        'extraBranchBorrowedProfile',
        'extraBranchChat',
        'extraBranchEditor',
        'extraBranchRegion',
        'extraBranchLog',
        'extraBranchComposer',
        'extraBranchControl',
        'extraBranchSend',
        'extraBranchLike',
        'extraBranchNav',
        'extraBranchContentProfile',
        'extraBranchDuplicateControl',
      ].map((key) => ({ observed: true, [key]: true })),
      { observed: true, wrongRecipient: true },
      { observed: true, wrongRecipient: true, neighbour: true },
      { e2eeAa: true, wrongRecipient: true },
      { observed: true, outsideProfileHeader: true, wrongRecipient: true },
      { observed: true, globalLinkOnly: true },
      { observed: true, outsideHeaderLink: true },
      { observed: true, headerLinkInMessages: true },
      { observed: true, duplicateRegion: true },
      { observed: true, duplicateComposer: true },
      { wrongRecipient: true },
      { wrongRecipient: true, neighbour: true },
      { globalLinkOnly: true },
      { outsideProfileLink: true, wrongRecipient: true },
      { outsideHeaderLink: true },
      { headerLinkInMessages: true },
      { draft: true },
      { unavailable: true },
      { noAction: true },
      { avatarLink: true, wrongAvatarLabel: true },
      { avatarLink: true, wrappedChatBody: true, wrongRecipient: true },
      { wrappedChatBody: true, outsideProfileLink: true, wrongRecipient: true },
      {
        avatarLink: true,
        wrappedChatBody: true,
        outsideProfileHeader: true,
        wrongRecipient: true,
      },
      { wrappedChatBody: true, outsideHeaderLink: true },
      { wrappedChatBody: true, headerLinkInMessages: true },
      { wrappedChatBody: true, duplicateRegion: true },
      { wrappedChatBody: true, duplicateComposer: true },
      { wrappedChatBody: true, extraBodyWrapper: true },
    ])(
      'never composes or marks an unbound/unavailable chat (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
          expect(f.mark).not.toHaveBeenCalled();
          expect(
            f.events.every(
              (event) =>
                event === 'open' ||
                (options.neighbour && event === 'close:neighbour'),
            ),
          ).toBe(true);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { observed: true, incidentalBranch: true, nestedPending: true },
      { observed: true, incidentalBranch: true, nestedFailed: true },
      { observed: true, oldOnly: true },
      { observed: true, oldOnly: true, markerOutgoing: true },
      { observed: true, rerenderAfterSend: true },
      { observed: true, incoming: true },
      { observed: true, missingSelf: true },
      { observed: true, sendInNeighbour: true, secondPopup: true },
      { observed: true, nestedPending: true },
      { observed: true, nestedFailed: true },
      { observed: true, eraseOnly: true },
      { oldOnly: true },
      { oldOnly: true, markerOutgoing: true },
      { recipientAfterSend: true },
      { incoming: true },
      { missingSelf: true },
      { sendInNeighbour: true, secondPopup: true },
      { rerenderAfterSend: true },
      { eraseOnly: true },
      { pending: true },
      { failed: true },
      { nestedPending: true },
      { nestedFailed: true },
      { statusLabel: true },
      { bodyStatusLabel: true },
      { bodySending: true, nestedPending: true },
    ])(
      'does not confirm old/incoming/neighbour/rerendered/pending text or editor disappearance (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events.filter((event) => event.startsWith('send:'))).toEqual(
            ['send:target'],
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { headerNameButton: true, decoratedHeader: true, markerHeaderName: true },
      { headerNameButton: true, decoratedHeader: true, clickHeaderName: true },
      { headerNameButton: true, markerHeaderName: true },
      { headerNameButton: true, markerSecondPopup: true },
      { headerNameButton: true, clickHeaderName: true },
      { headerNameButton: true, clickSecondPopup: true },
      { observed: true, markerExtraHeader: true },
      { observed: true, clickExtraHeader: true },
      { observed: true, clickExtraProfile: true },
      { observed: true, clickExtraControl: true },
      { observed: true, clickExtraEditor: true },
      { observed: true, clickExtraLog: true },
      { observed: true, documentCaptureRecipient: true },
      { observed: true, clickButton: true, documentCaptureButton: true },
      { observed: true, clickAvatarLabel: true },
      { observed: true, clickChatBodyReparent: true },
      { observed: true, markerNetwork: true },
      { observed: true, marker503: true },
      { markerRecipient: true },
      { markerRerender: true },
      { markerComposer: true },
      { markerBody: true },
      { markerFailure: true },
      { markerClose: true },
      { clickRecipient: true },
      { clickComposer: true },
      { clickBody: true },
      { clickButton: true },
      // A detached button still receives the in-flight click unless guarded.
      { clickButton: true, documentCaptureButton: true },
      { clickDuplicateButton: true },
      { clickDisabled: true },
      { clickReparent: true },
      { documentCaptureRecipient: true },
      { markerNetwork: true },
      { marker503: true },
      { avatarLink: true, wrappedChatBody: true, clickAvatarLabel: true },
      { avatarLink: true, wrappedChatBody: true, clickChatBodyReparent: true },
      {
        avatarLink: true,
        wrappedChatBody: true,
        documentCaptureRecipient: true,
      },
    ])(
      'does not dispatch or rebind after a durable marker failure/change (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject({
            code: 'delivery_uncertain',
          });
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.events).toEqual(['open', 'input:target', 'mark']);
          expect(f.dispatchPhases).toEqual(
            options.documentCaptureRecipient || options.documentCaptureButton
              ? ['click']
              : Object.keys(options).some((key) => key.startsWith('click'))
                ? ['pointerdown']
                : [],
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { networkAbort: true },
      { serviceUnavailable: true },
      { proxyFailure: true },
      { noAuth: true },
    ])(
      'does not invalidate cookies for transport/missing chrome (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events).toEqual([]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { checkpoint: true },
      { login: true },
      { markerRateLimit: true },
      { markerCheckpoint: true },
      { afterSendCheckpoint: true },
      { rateLimit: true },
    ])(
      'preserves session/checkpoint/rate-limit pause classification (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject(
            options.rateLimit || options.markerRateLimit
              ? { code: 'rate_limit' }
              : {
                  code: 'session_invalid',
                  reason: options.login ? 'login_required' : 'checkpoint',
                },
          );
          expect(f.mark).toHaveBeenCalledTimes(
            options.markerCheckpoint ||
              options.afterSendCheckpoint ||
              options.markerRateLimit
              ? 1
              : 0,
          );
          expect(
            f.events.filter((event) => event.startsWith('send:')).length,
          ).toBe(options.afterSendCheckpoint ? 1 : 0);
        } finally {
          await f.close();
        }
      },
    );
  },
);
