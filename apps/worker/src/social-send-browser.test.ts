import { expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { SocialSendError } from '@sonar/core/social-session';
import {
  createSocialSendBrowser,
  type SocialSessionAccount,
} from './social-send-browser.js';

const account: SocialSessionAccount = {
  id: 'account',
  channel: 'instagram',
  settings: { cookiesEncrypted: 'encrypted' },
};
const session = {
  cookies: [
    { name: 'sessionid', value: 'secret', domain: '.instagram.com', path: '/' },
  ],
  proxy: { server: 'http://proxy.example:8000' },
};
function fixture(
  options: {
    checkpoint?: boolean;
    confirm?: boolean;
    personalFacebook?: boolean;
    postCheckpoint?: boolean;
    noMessage?: boolean;
    noDialog?: boolean;
    dialogLink?: string;
  } = {},
) {
  const events: string[] = [];
  const ownWait = vi.fn(async () => {
    if (options.confirm === false) throw Error('timeout');
  });
  const exact = vi.fn((value: string | RegExp) => ({
    exact: true,
    count: async () =>
      value instanceof RegExp &&
      value.test('Page transparency') &&
      !options.personalFacebook
        ? 1
        : 0,
  }));
  const ownFilter = vi.fn(() => ({
    count: async () => 2,
    nth: vi.fn(() => ({ waitFor: ownWait })),
  }));
  let url = '';
  const page = {
    goto: vi.fn(async (target: string) => {
      url = options.checkpoint
        ? 'https://www.instagram.com/challenge/'
        : target.startsWith('https://ig.me/')
          ? 'https://www.instagram.com/direct/t/thread/'
          : target.startsWith('https://m.me/')
            ? 'https://www.facebook.com/messages/t/thread/'
            : target;
    }),
    url: () => url,
    locator: vi.fn((selector: string) => ({
      getAttribute: async () => options.dialogLink ?? null,
      count: async () =>
        selector.includes('[role="dialog"]')
          ? options.dialogLink
            ? 1
            : 0
          : selector.startsWith('input[type="password"]')
            ? 0
            : selector.includes('page_transparency') && options.personalFacebook
              ? 0
              : 1,
      filter: ownFilter,
      first: () => ({ waitFor: async () => {} }),
      last: () => ({
        fill: async () => {
          events.push('fill');
        },
        press: async (key: string) => {
          expect(key).toBe('Enter');
          events.push('click');
          if (options.postCheckpoint)
            url = 'https://www.instagram.com/challenge/';
        },
      }),
    })),
    getByRole: vi.fn((_role: string, roleOptions: { name: RegExp }) => ({
      first: () => ({
        isVisible: async () => !options.noMessage,
        click: async () => {
          events.push('open');
          if (url.includes('linkedin.com') && !options.noDialog)
            url = 'https://www.linkedin.com/messaging/thread/thread/';
        },
      }),
      last: () => ({
        click: async () => {
          expect(roleOptions.name.test('Send')).toBe(true);
          events.push('click');
        },
      }),
    })),
    getByText: exact,
    setDefaultTimeout: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const context = {
    addCookies: vi.fn(async () => {}),
    newPage: vi.fn(async () => page as unknown as Page),
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async () => browser as unknown as Browser);
  return {
    adapter: createSocialSendBrowser(launch),
    browser,
    context,
    page,
    events,
    ownWait,
    ownFilter,
    exact,
  };
}
it('binds one reusable account context to its proxy and cookies, serializes checks, and rotates changed credentials', async () => {
  const f = fixture();
  await Promise.all([
    f.adapter.check(account, session, 1000),
    f.adapter.check(account, session, 1000),
  ]);
  expect(f.browser.newContext).toHaveBeenCalledTimes(1);
  expect(f.browser.newContext).toHaveBeenCalledWith(
    expect.objectContaining({ proxy: session.proxy }),
  );
  expect(f.context.addCookies).toHaveBeenCalledWith(session.cookies);
  expect(f.page.goto.mock.invocationCallOrder[1]).toBeGreaterThan(
    f.page.close.mock.invocationCallOrder[0]!,
  );
  await f.adapter.check(
    { ...account, settings: { cookiesEncrypted: 'new' } },
    session,
    1000,
  );
  expect(f.browser.newContext).toHaveBeenCalledTimes(2);
  await f.adapter.close();
  expect(f.browser.close).toHaveBeenCalledOnce();
});
it('stops at a checkpoint before opening a composer or marking a send attempt', async () => {
  const f = fixture({ checkpoint: true });
  const beforeSend = vi.fn();
  await expect(
    f.adapter.send(
      account,
      session,
      1000,
      'https://instagram.com/company/',
      'Hello',
      beforeSend,
    ),
  ).rejects.toMatchObject({ code: 'session_invalid' });
  expect(beforeSend).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
it('marks the durable attempt immediately before clicking and requires a new outgoing exact-text confirmation', async () => {
  const f = fixture();
  const id = await f.adapter.send(
    account,
    session,
    1000,
    'https://instagram.com/company/',
    'Hello',
    async () => {
      f.events.push('mark');
    },
  );
  expect(id).toBe('https://www.instagram.com/direct/t/thread/');
  expect(f.events).toEqual(['fill', 'mark', 'click']);
  expect(f.exact).toHaveBeenCalledWith('Hello', { exact: true });
  expect(f.ownWait).toHaveBeenCalledWith({ state: 'visible', timeout: 1000 });
});
it('reports an uncertain delivery after click without retrying or claiming success', async () => {
  const f = fixture({ confirm: false });
  await expect(
    f.adapter.send(
      account,
      session,
      1000,
      'https://instagram.com/company/',
      'Hello',
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'delivery_uncertain' });
  expect(f.events.filter((event) => event === 'click')).toHaveLength(1);
});
it('never clicks send if the durable marker cannot be saved', async () => {
  const f = fixture();
  await expect(
    f.adapter.send(
      account,
      session,
      1000,
      'https://instagram.com/company/',
      'Hello',
      async () => {
        throw Error('database offline');
      },
    ),
  ).rejects.toBeInstanceOf(SocialSendError);
  expect(f.events).toEqual(['fill']);
});
it('rejects personal LinkedIn and unverified Facebook profiles before composing', async () => {
  const f = fixture({ personalFacebook: true });
  await expect(
    f.adapter.send(
      { ...account, channel: 'linkedin' },
      session,
      1000,
      'https://linkedin.com/in/person/',
      'Hello',
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.page.goto).not.toHaveBeenCalled();
  await expect(
    f.adapter.send(
      { ...account, channel: 'facebook' },
      session,
      1000,
      'https://facebook.com/person/',
      'Hello',
      async () => {},
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.events).toEqual([]);
});

it('preserves a post-click checkpoint as session_invalid so the account is paused while the durable attempt remains', async () => {
  const f = fixture({ postCheckpoint: true, confirm: false });
  const mark = vi.fn(async () => {});
  await expect(
    f.adapter.send(
      account,
      session,
      1000,
      'https://instagram.com/company/',
      'Hello',
      mark,
    ),
  ).rejects.toMatchObject({
    code: 'session_invalid',
    reasonUk: 'Увійдіть знову (оновіть cookies)',
  });
  expect(mark).toHaveBeenCalledOnce();
  expect(f.events).toEqual(['fill', 'click']);
});

it.each(['facebook', 'linkedin'] as const)(
  'sends to a confirmed %s company dialog using the send button',
  async (network) => {
    const f = fixture();
    const to =
      network === 'linkedin'
        ? 'https://linkedin.com/company/company/'
        : 'https://facebook.com/company/';
    await f.adapter.send(
      { ...account, channel: network },
      session,
      1000,
      to,
      'Hello',
      async () => {
        f.events.push('mark');
      },
    );
    expect(f.events).toEqual(
      network === 'linkedin'
        ? ['open', 'fill', 'mark', 'click']
        : ['fill', 'mark', 'click'],
    );
  },
);
it('skips a LinkedIn company with no Message button and reports the exact reason', async () => {
  const f = fixture({ noMessage: true });
  await expect(
    f.adapter.send(
      { ...account, channel: 'linkedin' },
      session,
      1000,
      'https://linkedin.com/company/company/',
      'Hello',
      async () => {},
    ),
  ).rejects.toMatchObject({
    code: 'unavailable',
    reasonUk: 'Сторінка LinkedIn не приймає повідомлень',
  });
  expect(f.events).toEqual([]);
});

it('keeps delivery uncertain after confirmed text when no dialog URL can be identified', async () => {
  const f = fixture({ noDialog: true });
  const mark = vi.fn(async () => {});
  await expect(
    f.adapter.send(
      { ...account, channel: 'linkedin' },
      session,
      1000,
      'https://linkedin.com/company/company/',
      'Hello',
      mark,
    ),
  ).rejects.toMatchObject({
    code: 'delivery_uncertain',
    reasonUk: 'Перевірте чат вручну',
  });
  expect(mark).toHaveBeenCalledOnce();
  expect(f.events).toEqual(['open', 'fill', 'click']);
});
it('uses a unique thread link from the active conversation overlay as providerId', async () => {
  const f = fixture({
    noDialog: true,
    dialogLink: '/messaging/thread/thread/?tracking=removed',
  });
  await expect(
    f.adapter.send(
      { ...account, channel: 'linkedin' },
      session,
      1000,
      'https://linkedin.com/company/company/',
      'Hello',
      async () => {},
    ),
  ).resolves.toBe('https://www.linkedin.com/messaging/thread/thread/');
});
