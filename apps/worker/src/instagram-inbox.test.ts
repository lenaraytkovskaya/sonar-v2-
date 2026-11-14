import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Page, Response } from 'playwright';
import type { SocialInboxBatch } from '@sonar/core/social-inbox';
import { validateSocialInboxMessage } from '@sonar/core/social-inbox';
import { parseInstagramInbox } from './instagram-inbox-parser.js';

vi.mock('./social-inbox.js', () => ({
  SocialInboxAdapterError: class extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(reasonUk);
    }
  },
}));
import {
  captureInstagramInbox,
  createSocialInboxAdapter,
} from './instagram-inbox-browser.js';

const observedAt = '2026-11-14T12:00:00.000Z';
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL('./instagram-inbox.fixture.json', import.meta.url),
      'utf8',
    ),
  );
const mailbox = (value = fixture()) =>
  value.data.get_slide_mailbox_for_iris_subscription;
const thread = (value: ReturnType<typeof fixture>) =>
  mailbox(value).threads_by_folder.edges[0].node.as_ig_direct_thread;

it('maps observed true identities, exact text, timestamps and provider IDs', () => {
  const parsed = parseInstagramInbox(fixture(), observedAt)!;
  expect(parsed.skipped).toEqual([]);
  expect(parsed.inbox?.more).toBe(false);
  expect(parsed.threads[0]?.page?.more).toBe(false);
  expect(parsed.messages.map((message) => message.direction)).toEqual([
    'in',
    'out',
    'out',
    'out',
    'out',
  ]);
  expect(parsed.messages[1]).toMatchObject({
    externalMessageId: '900000000000008',
    threadId: '900000000000005',
    senderPlatformId: '900000000000003',
    body: 'Synthetic test message 2',
    occurredAt: '2023-11-15T00:09:43.435Z',
    peerProfile: 'https://www.instagram.com/example_peer/',
    threadUrl: 'https://www.instagram.com/direct/t/900000000000005/',
  });
  expect(parsed.messages[1]?.senderProfile).toBeUndefined();
  parsed.messages.forEach((message) =>
    expect(() =>
      validateSocialInboxMessage('instagram', message),
    ).not.toThrow(),
  );
  const reload = fixture();
  thread(reload).slide_messages.edges[0].cursor = 'changed-opaque-cursor';
  expect(parseInstagramInbox(reload, observedAt)?.messages).toEqual(
    parsed.messages,
  );
});

it.each([
  [
    'unknown sender',
    (t: ReturnType<typeof thread>) => {
      t.slide_messages.edges[0].node.sender_fbid = '999';
    },
    'unknown_sender',
  ],
  [
    'missing message id',
    (t: ReturnType<typeof thread>) => {
      delete t.slide_messages.edges[0].node.id;
    },
    'invalid_message',
  ],
  [
    'invalid timestamp',
    (t: ReturnType<typeof thread>) => {
      t.slide_messages.edges[0].node.timestamp_ms = 'bad';
    },
    'invalid_message',
  ],
  [
    'snippet only',
    (t: ReturnType<typeof thread>) => {
      delete t.slide_messages.edges[0].node.text_body;
      delete t.slide_messages.edges[0].node.content.text_body;
    },
    'invalid_message',
  ],
  [
    'group',
    (t: ReturnType<typeof thread>) => {
      t.is_group = true;
    },
    'group_unsupported',
  ],
  [
    'multiple peers',
    (t: ReturnType<typeof thread>) => {
      t.users.push({ ...t.users[0], id: '8' });
    },
    'ambiguous_thread_identity',
  ],
  [
    'missing viewer',
    (t: ReturnType<typeof thread>) => {
      delete t.viewer;
    },
    'ambiguous_thread_identity',
  ],
  [
    'unsafe thread id',
    (t: ReturnType<typeof thread>) => {
      t.thread_id = '../unsafe';
    },
    'ambiguous_thread_identity',
  ],
] as const)(
  'rejects %s without guessing source evidence',
  (_name, mutate, reason) => {
    const value = fixture();
    mutate(thread(value));
    expect(parseInstagramInbox(value, observedAt)?.skipped).toContain(reason);
  },
);

it('marks missing pagination and accepts full content text, never a snippet', () => {
  const value = fixture();
  delete thread(value).slide_messages.page_info;
  delete thread(value).slide_messages.edges[0].node.text_body;
  delete mailbox(value).threads_by_folder.page_info;
  const parsed = parseInstagramInbox(value, observedAt)!;
  expect(parsed.inbox).toBeNull();
  expect(parsed.threads[0]?.page).toBeNull();
  expect(parsed.messages[0]?.body).toBe('Synthetic test message 1');
  expect(
    parseInstagramInbox({ data: { unrelated: {} } }, observedAt),
  ).toBeNull();
});

function browser(
  initial: unknown[],
  scrollResponses: unknown[][] = [],
  url = 'https://www.instagram.com/api/graphql',
) {
  let listener: ((response: Response) => void) | undefined;
  let currentUrl = '';
  const events: string[] = [];
  const emit = (values: unknown[]) =>
    values.forEach((value) =>
      listener?.({
        url: () => url,
        status: () => 200,
        request: () => ({ method: () => 'POST' }),
        json: async () => value,
      } as unknown as Response),
    );
  const page = {
    on: vi.fn((_event, fn) => {
      listener = fn;
      events.push('listen');
    }),
    off: vi.fn(() => {
      listener = undefined;
    }),
    goto: vi.fn(async (target: string) => {
      currentUrl = target;
      events.push('navigate');
      emit(initial);
      return { status: () => 200 };
    }),
    url: () => currentUrl,
    waitForTimeout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    locator: vi.fn(() => ({
      count: async () => 1,
      evaluate: vi.fn(async () => {
        events.push('scroll');
        emit(scrollResponses.shift() ?? []);
      }),
    })),
  };
  const batches: SocialInboxBatch[] = [];
  const persist = vi.fn(async (batch: SocialInboxBatch) => {
    events.push('persist-start');
    await new Promise((resolve) => setTimeout(resolve, 1));
    batches.push(batch);
    events.push('persist-end');
  });
  const assert = vi.fn(async () => {});
  const run = () =>
    captureInstagramInbox(page as unknown as Page, 50, persist, assert);
  return { page, events, batches, persist, assert, run };
}

it('attaches before navigation, serially persists every chunk and deduplicates repeat captures', async () => {
  const f = browser([fixture(), fixture()]);
  expect(await f.run()).toMatchObject({ complete: true, skipped: [] });
  expect(f.events.slice(0, 2)).toEqual(['listen', 'navigate']);
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0]);
  expect(f.events).toEqual([
    'listen',
    'navigate',
    'persist-start',
    'persist-end',
    'persist-start',
    'persist-end',
  ]);
  expect(f.page.off).toHaveBeenCalledOnce();
  expect(f.assert).toHaveBeenCalledTimes(4);
});

it('awaits persistence before bounded inbox scrolling and requires a captured terminal page', async () => {
  const first = fixture();
  mailbox(first).threads_by_folder.page_info.has_next_page = true;
  const f = browser([first], [[fixture()]]);
  expect(await f.run()).toMatchObject({ complete: true });
  expect(f.events.indexOf('scroll')).toBeGreaterThan(
    f.events.indexOf('persist-end'),
  );
  expect(f.page.locator).toHaveBeenCalledWith(
    '[data-pagelet="IGDInboxThreadListScrollableAreaPagelet"]',
  );
});

it('scrolls only the observed message container for incomplete thread history', async () => {
  const first = fixture();
  thread(first).slide_messages.page_info.has_next_page = true;
  const f = browser([first], [[fixture()]]);
  expect(await f.run()).toMatchObject({ complete: true });
  expect(f.page.goto).toHaveBeenNthCalledWith(
    2,
    'https://www.instagram.com/direct/t/900000000000005/',
    expect.any(Object),
  );
  expect(f.page.locator).toHaveBeenCalledWith(
    '[data-pagelet="IGDMessagesList"]',
  );
  expect(f.events.indexOf('scroll')).toBeGreaterThan(
    f.events.indexOf('persist-end'),
  );
});

it('does not accept terminal thread history as evidence of terminal inbox pagination', async () => {
  const first = fixture();
  mailbox(first).threads_by_folder.page_info.has_next_page = true;
  thread(first).slide_messages.page_info.has_next_page = true;
  const f = browser([first], [[fixture()]]);
  expect(await f.run()).toMatchObject({ complete: false });
});

it.each([
  'missing-pagination',
  'group',
  'no-response',
  'other-origin',
  'identity-conflict',
  'unseen-history',
])('returns incomplete for %s', async (reason) => {
  const value = fixture();
  if (reason === 'missing-pagination')
    delete mailbox(value).threads_by_folder.page_info;
  if (reason === 'group') thread(value).is_group = true;
  if (reason === 'unseen-history')
    thread(value).slide_messages.page_info.has_next_page = true;
  const conflict = fixture();
  thread(conflict).slide_messages.edges[0].node.sender_fbid = '900000000000003';
  const f = browser(
    reason === 'no-response'
      ? []
      : reason === 'identity-conflict'
        ? [value, conflict]
        : [value],
    [],
    reason === 'other-origin' ? 'https://evil.example/api/graphql' : undefined,
  );
  const result = await f.run();
  expect(result).toMatchObject({ complete: false, reason: 'unsupported_dom' });
  if (reason === 'group') expect(result.skipped).toContain('group_unsupported');
});

it('propagates persistence/session failures and always detaches the response listener', async () => {
  const f = browser([fixture()]);
  f.persist.mockRejectedValueOnce(new Error('save failed'));
  await expect(f.run()).rejects.toThrow('save failed');
  expect(f.page.off).toHaveBeenCalledOnce();
  const blocked = browser([fixture()]);
  blocked.assert.mockRejectedValueOnce(new Error('login required'));
  await expect(blocked.run()).rejects.toThrow('login required');
  expect(blocked.page.off).toHaveBeenCalledOnce();
});

it('delegates account, pinned session and configured timeout to the shared browser factory', async () => {
  const account = {
    id: 'test',
    channel: 'instagram' as const,
    settings: {},
    session: {} as never,
  };
  const withPage = vi.fn(async () => ({ complete: true }));
  const adapter = createSocialInboxAdapter(async () => 12345, {
    withPage,
  } as unknown as Parameters<typeof createSocialInboxAdapter>[1]);
  const persist = vi.fn();
  expect(
    await adapter.sync(
      account,
      { watermark: null, cycleStartedAt: null, resumeAnchor: null },
      persist,
    ),
  ).toEqual({ complete: true });
  expect(withPage).toHaveBeenCalledWith(
    account,
    account.session,
    12345,
    expect.any(Function),
  );
});

it.each(['facebook', 'linkedin'] as const)(
  'explicitly rejects %s without opening a browser',
  async (channel) => {
    const adapter = createSocialInboxAdapter(async () => {
      throw Error('must not run');
    });
    await expect(
      adapter.sync(
        { id: 'test', channel, settings: {}, session: {} as never },
        { watermark: null, cycleStartedAt: null, resumeAnchor: null },
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: channel === 'facebook' ? 'history_locked' : 'unsupported_dom',
    });
  },
);
