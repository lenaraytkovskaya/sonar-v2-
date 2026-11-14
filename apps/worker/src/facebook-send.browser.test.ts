import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createSocialSendBrowser } from './social-send-browser.js';

// Synthetic generic wrappers. Only labels, relationships and Lexical attributes
// come from root's English UI observations; no live account data or invented IDs.
const markup = `
<style>[contenteditable] { min-height: 24px; } [aria-label^="Messages in conversation"] { min-height: 30px; } [role="button"] { min-height: 18px; min-width: 18px; }</style>
<nav aria-label="Account"><a href="/100000000000009/">Synthetic self</a></nav>
<main><h1>Synthetic recipient</h1><button id="open">Message</button></main>
<div id="chats"></div>
<script>
const o = window.fixtureOptions;
const body = o.bodyPending ? 'Pending review' : 'Synthetic message';
const recipient = o.company ? 'synthetic_company' : '100000000000001';
const label = 'Synthetic Recipient';
function row(own = true, text = body, time = '4 November 2026, 20:15') {
  const wrapper = document.createElement('div');
  const sender = own ? 'You' : 'Synthetic Recipient';
  wrapper.innerHTML = '<div aria-label="At ' + time + ', ' + sender + ': ' + text + '"><h2>' +
    (own ? 'You sent' : sender) + '</h2><span>' + text + '</span></div>' +
    '<div role="button" aria-label="Enter, Message sent ' + time + ' by ' + sender + ': ' + text + '"></div>';
  return wrapper;
}
function chat(id, target, name) {
  const scope = document.createElement('section'); scope.id = id;
  // Header-like generic container, deliberately not a header element.
  scope.innerHTML = '<div><a href="https://www.facebook.com/' + target + '/">' + name + '</a>' +
    '<div role="button" aria-label="Chat settings" aria-haspopup="menu"></div>' +
    '<button>Start a voice call</button><button>Start a video call</button><button>Minimise chat</button><button>Close chat</button></div>' +
    '<h2>Messages</h2><div aria-label="Messages in conversation with ' + name + '"></div>' +
    '<div aria-label="Thread composer"><div contenteditable="true" role="textbox" spellcheck="true" tabindex="0" ' +
    'aria-describedby="synthetic-description" aria-label="Write to ' + name + '" aria-placeholder="Aa" data-lexical-editor="true"><p dir="auto"></p></div>' +
    '<div role="button" tabindex="0" aria-label="Send a Like"><svg><title>Send a Like</title></svg></div></div>';
  return scope;
}
const region = scope => scope.querySelector('[aria-label^="Messages in conversation"]');
function wire(scope) {
  const editor = scope.querySelector('[contenteditable]');
  const button = scope.querySelector('[aria-label="Send a Like"], [aria-label="Press Enter to send"]');
  editor.addEventListener('input', () => {
    window.fixtureEvent('input:' + scope.id);
    button.setAttribute('aria-label', editor.textContent ? 'Press Enter to send' : 'Send a Like');
    if (o.rerenderFill && !window.rerendered) {
      window.rerendered = true; const replacement = scope.cloneNode(true); scope.replaceWith(replacement); wire(replacement);
    }
  });
  button.addEventListener('click', () => {
    window.fixtureEvent('send:' + scope.id);
    if (o.afterSendCheckpoint) { document.body.insertAdjacentHTML('beforeend', '<form action="/checkpoint/"><button>Continue</button></form>'); return; }
    if (o.eraseOnly) { editor.textContent = ''; return; }
    if (o.rerenderAfterSend) { region(scope).innerHTML = region(scope).innerHTML; return; }
    if (o.oldOnly) return;
    const destination = o.sendInNeighbour ? region(document.querySelector('#neighbour')) : region(scope);
    const next = row(!o.incoming, body, o.sameTimestamp ? '4 November 2026, 20:15' : '4 November 2026, 20:16');
    if (o.missingSelf) next.querySelector('h2').textContent = 'Synthetic Recipient';
    if (o.pending || o.failed) next.insertAdjacentHTML('beforeend', '<span>' + (o.pending ? 'Sending' : 'Not sent. Retry') + '</span>');
    if (o.pendingSettles) { next.insertAdjacentHTML('beforeend', '<span class="status">Sending</span>'); setTimeout(() => next.querySelector('.status').remove(), 40); }
    destination.append(next); editor.textContent = '';
    if (o.recipientAfterSend) scope.querySelector('a').href = '/100000000000002/';
  });
}
document.querySelector('#open').onclick = () => {
  window.fixtureEvent('open');
  if (o.unavailable) return;
  const show = () => {
    const scope = chat('target', o.wrongRecipient ? '100000000000002' : recipient, label);
    if (o.oldOnly || o.sameTimestamp || o.rerenderAfterSend) region(scope).append(row());

    document.querySelector('#chats').append(scope); wire(scope);
    if (o.noSettingsLabel) scope.querySelector('[aria-label="Chat settings"]').removeAttribute('aria-label');
    if (o.headerProfilePhp) scope.querySelector('a').href = '/profile.php?id=' + recipient;
    if (o.globalLinkOnly) { scope.querySelector('a').remove(); document.querySelector('nav').insertAdjacentHTML('beforeend', '<a href="/' + recipient + '/">' + label + '</a>'); }
    if (o.draft) scope.querySelector('[contenteditable]').textContent = 'Existing draft';
  };
  if (o.delayedChat) setTimeout(show, 40); else show();
};
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
      let page: Page;
      context.on('page', (value) => {
        page = value;
      });
      const events: string[] = [];
      const requests: string[] = [];
      const target = options.company
        ? 'https://www.facebook.com/synthetic_company/'
        : 'https://www.facebook.com/profile.php?id=100000000000001';
      await context.exposeBinding('fixtureEvent', (_source, event: string) => {
        events.push(event);
      });
      await context.addInitScript({
        content: `window.fixtureOptions = ${JSON.stringify(options)}`,
      });
      await context.route('**/*', (route) => {
        requests.push(route.request().url());
        if (route.request().url() !== target)
          return route.abort('blockedbyclient');
        return route.fulfill({
          contentType: 'text/html',
          status: options.rateLimit ? 429 : 200,
          body: markup,
        });
      });
      const adapter = createSocialSendBrowser(
        async () => ({ newContext: async () => context }) as unknown as Browser,
      );
      const mark = vi.fn(async () => {
        events.push('mark');
        if (options.markerOutgoing)
          await page.evaluate(() => {
            const region = document.querySelector(
              '#target [aria-label^="Messages in conversation"]',
            )!;
            region.append(region.firstElementChild!.cloneNode(true));
          });
        if (options.markerFailure) throw Error('private callback failure');
        if (options.markerClose) await page.close();
        if (options.markerCheckpoint)
          await page.evaluate(() =>
            document.body.insertAdjacentHTML(
              'beforeend',
              '<form action="/checkpoint/"><button>Continue</button></form>',
            ),
          );
        if (options.markerRecipient)
          await page.evaluate(() => {
            document.querySelector<HTMLAnchorElement>('#target a')!.href =
              '/100000000000002/';
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
        requests,
        mark,
        target,
        send: () =>
          adapter.send(
            { id: 'synthetic', channel: 'facebook', settings: {} },
            { cookies: [], proxy: { server: 'http://127.0.0.1:9' } },
            400,
            target,
            options.bodyPending ? 'Pending review' : 'Synthetic message',
            mark,
          ),
        close: () => context.close(),
      };
    }
    it.each([
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
    ])(
      'sends once to a bound direct profile/Page and confirms a distinct outgoing (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).resolves.toBe(f.target);
          expect(f.events).toEqual([
            'open',
            'input:target',
            'mark',
            'send:target',
          ]);
          expect(f.mark).toHaveBeenCalledOnce();
          expect(f.requests).toEqual([f.target]);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { wrongRecipient: true },
      { wrongRecipient: true, neighbour: true },
      { globalLinkOnly: true },
      { draft: true },
      { unavailable: true },
      { noAction: true },
    ])(
      'never composes or marks an unbound/unavailable chat (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject({ code: 'unavailable' });
          expect(f.mark).not.toHaveBeenCalled();
          expect(f.events.every((event) => event === 'open')).toBe(true);
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { oldOnly: true },
      { oldOnly: true, markerOutgoing: true },
      { recipientAfterSend: true },
      { incoming: true },
      { missingSelf: true },
      { sendInNeighbour: true, neighbour: true },
      { rerenderAfterSend: true },
      { eraseOnly: true },
      { pending: true },
      { failed: true },
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
      { markerRecipient: true },
      { markerRerender: true },
      { markerComposer: true },
      { markerBody: true },
      { markerFailure: true },
      { markerClose: true },
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
        } finally {
          await f.close();
        }
      },
    );
    it.each([
      { checkpoint: true },
      { markerCheckpoint: true },
      { afterSendCheckpoint: true },
      { rateLimit: true },
    ])(
      'preserves session/checkpoint/rate-limit pause classification (%j)',
      async (options) => {
        const f = await fixture(options);
        try {
          await expect(f.send()).rejects.toMatchObject(
            options.rateLimit
              ? { code: 'rate_limit' }
              : { code: 'session_invalid', reason: 'checkpoint' },
          );
          expect(f.mark).toHaveBeenCalledTimes(
            options.markerCheckpoint || options.afterSendCheckpoint ? 1 : 0,
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
