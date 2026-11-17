import { expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { normalizeSocialCookies } from '@sonar/core/social-session';
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
    actionBlocked?: string;
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
    filter: () => ({
      count: async () =>
        options.actionBlocked &&
        value instanceof RegExp &&
        value.test(options.actionBlocked)
          ? 1
          : 0,
    }),
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
    on: vi.fn(),
    goto: vi.fn(async (target: string) => {
      url = options.checkpoint
        ? 'https://www.instagram.com/challenge/'
        : target.startsWith('https://ig.me/')
          ? 'https://www.instagram.com/direct/t/thread/'
          : target.startsWith('https://m.me/')
            ? 'https://www.facebook.com/messages/t/thread/'
            : target;
      return { status: () => 200 };
    }),
    url: () => url,
    locator: vi.fn((selector: string) => ({
      getAttribute: async () => options.dialogLink ?? null,
      count: async () =>
        selector.includes('[role="dialog"]')
          ? options.dialogLink
            ? 1
            : 0
          : selector.startsWith('input[type="password"]') ||
              selector.startsWith('iframe') ||
              selector.startsWith('form[action')
            ? 0
            : selector.includes('page_transparency') && options.personalFacebook
              ? 0
              : 1,
      filter: selector.includes('[role="alert"]')
        ? () => ({ count: async () => 0 })
        : selector.includes('msg-s-message') ||
            selector.includes('aria-label^="You sent')
          ? ownFilter
          : () => ({
              count: async () =>
                selector.includes('global-nav__primary-link-me-menu-trigger')
                  ? 1
                  : 0,
              first: () => ({ waitFor: async () => {} }),
            }),
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
    waitForTimeout: vi.fn(async () => {}),
  };
  const context = {
    storageState: vi.fn(async () => ({
      cookies: normalizeSocialCookies(
        JSON.stringify(session.cookies),
        'instagram',
      ),
      origins: [
        {
          origin: 'https://www.instagram.com',
          localStorage: [{ name: 'token', value: 'rotated' }],
        },
      ],
    })),
    addCookies: vi.fn(async () => {}),
    newPage: vi.fn(async () => page as unknown as Page),
    close: vi.fn(async () => {}),
  };
  const browser = {
    version: () => '142.0.1.0',
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
it('rejects personal LinkedIn before navigation', async () => {
  const f = fixture();
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
  expect(f.events).toEqual([]);
});

it('sends to a LinkedIn company dialog using the send button', async () => {
  const f = fixture();
  const to = 'https://linkedin.com/company/company/';
  await f.adapter.send(
    { ...account, channel: 'linkedin' },
    session,
    1000,
    to,
    'Hello',
    async () => {
      f.events.push('mark');
    },
  );
  expect(f.events).toEqual(['open', 'fill', 'mark', 'click']);
});

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

it.each([
  [
    Object.assign(Error('private navigation details'), {
      name: 'TimeoutError',
    }),
    'timeout',
  ],
  [
    Error('net::ERR_PROXY_CONNECTION_FAILED https://user:secret@proxy.test/'),
    'proxy',
  ],
  [
    Error('net::ERR_CONNECTION_RESET https://private.test/?cookies=secret'),
    'network',
  ],
])('classifies adapter navigation errors safely', async (error, reason) => {
  const f = fixture();
  f.page.goto.mockRejectedValueOnce(error);
  await expect(f.adapter.check(account, session, 1000)).rejects.toMatchObject({
    reason,
  });
  expect(f.page.close).toHaveBeenCalledOnce();
  await f.adapter.close();
});
it('keeps context/browser failures separate from invalid cookies', async () => {
  const f = fixture();
  f.context.addCookies.mockRejectedValueOnce(
    Error('Browser closed; private cookies'),
  );
  await expect(f.adapter.check(account, session, 1000)).rejects.toMatchObject({
    reason: 'browser',
    code: 'unavailable',
  });
  await f.adapter.close();
});

it('restores full state and saves rotations with the same persistent device after a successful check', async () => {
  const f = fixture();
  const state = await f.context.storageState();
  const persistStorageState = vi.fn(async () => {});
  const persistDevice = vi.fn(async () => {});
  const durable = {
    ...session,
    device: {
      userAgent: '',
      viewport: { width: 1366, height: 768 },
      locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv',
      deviceScaleFactor: 1,
    },
    storageState: state,
    persistStorageState,
    persistDevice,
  };
  await f.adapter.check(account, durable, 1000);
  const options = (
    f.browser.newContext.mock.calls as unknown as [unknown][]
  )[0]![0];
  expect(options).toMatchObject({
    storageState: state,
    userAgent: expect.stringContaining('Chrome/142.0.1.0'),
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    deviceScaleFactor: 1,
  });
  expect(f.context.addCookies).not.toHaveBeenCalled();
  expect(persistDevice.mock.invocationCallOrder[0]).toBeLessThan(
    f.page.goto.mock.invocationCallOrder[0]!,
  );
  expect(persistStorageState).toHaveBeenCalledWith(
    state,
    expect.objectContaining({
      userAgent: expect.stringContaining('Chrome/142.0.1.0'),
    }),
  );
  await f.adapter.close();
});
it('does not overwrite durable state on a checkpoint or an empty browser state', async () => {
  const persistStorageState = vi.fn(async () => {});
  const persistDevice = vi.fn(async () => {});
  const broken = fixture({ checkpoint: true });
  await expect(
    broken.adapter.check(
      account,
      { ...session, device: undefined, persistDevice, persistStorageState },
      1000,
    ),
  ).rejects.toMatchObject({ reason: 'checkpoint' });
  expect(persistDevice).toHaveBeenCalledOnce();
  expect(persistStorageState).not.toHaveBeenCalled();
  await broken.adapter.close();
  const empty = fixture();
  empty.context.storageState.mockResolvedValue({ cookies: [], origins: [] });
  await empty.adapter.check(account, { ...session, persistStorageState }, 1000);
  expect(persistStorageState).not.toHaveBeenCalled();
  await empty.adapter.close();
});
it('keepalive opens the authenticated feed, waits and persists the refreshed state', async () => {
  const f = fixture();
  const persistStorageState = vi.fn(async () => {});
  await f.adapter.keepalive(
    account,
    { ...session, persistStorageState },
    1000,
    1500,
  );
  expect(f.page.goto).toHaveBeenCalledWith(
    'https://www.instagram.com/',
    expect.anything(),
  );
  expect(f.page.waitForTimeout).toHaveBeenCalledWith(1500);
  expect(persistStorageState).toHaveBeenCalledOnce();
  await f.adapter.close();
});
it('retains the successful operation result if a post-dispatch state save fails', async () => {
  const f = fixture();
  const result = await f.adapter.withPage(
    account,
    {
      ...session,
      persistStorageState: async () => {
        throw Error('storage failed');
      },
    },
    1000,
    async () => 'confirmed-provider-id',
    true,
  );
  expect(result).toBe('confirmed-provider-id');
  await f.adapter.close();
});

it.each(['Action blocked', 'Попробуйте позже', 'Дію заблоковано'])(
  'stops sending and reading on a visible account restriction: %s',
  async (text) => {
    const f = fixture({ actionBlocked: text });
    const beforeSend = vi.fn();
    await expect(f.adapter.check(account, session, 1000)).rejects.toMatchObject(
      { reason: 'action_blocked' },
    );
    await expect(
      f.adapter.send(
        account,
        session,
        1000,
        'https://instagram.com/company/',
        'Hello',
        beforeSend,
      ),
    ).rejects.toMatchObject({ reason: 'action_blocked' });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);
