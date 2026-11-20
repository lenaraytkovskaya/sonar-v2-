import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Page, Response } from 'playwright';
import type { SocialInboxBatch } from '@sonar/core/social-inbox';
import { validateSocialInboxMessage } from '@sonar/core/social-inbox';
import { SocialSessionCheckError } from '@sonar/core/social-session';
import {
  parseInstagramInbox,
  parseInstagramRequests,
} from './instagram-inbox-parser.js';

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

// Structural schema reported from native Chrome Network on 2026-11-15;
// all values are synthetic. The unread-count query carries no actor/messages.
const unreadFixture = () =>
  JSON.parse(
    readFileSync(
      new URL('./instagram-unread-count.fixture.json', import.meta.url),
      'utf8',
    ),
  );
const folderTabsFixture = readFileSync(
  new URL('./instagram-inbox-folders.fixture.html', import.meta.url),
  'utf8',
);
const requestsFixture = () =>
  JSON.parse(
    readFileSync(
      new URL('./instagram-requests.fixture.json', import.meta.url),
      'utf8',
    ),
  );
const requestPreviewFixture = () => {
  const value = fixture();
  const requestThread = thread(value);
  requestThread.folder = 'REQUESTS';
  requestThread.slide_messages.edges[0].node.igd_snippet = 'Preview only';
  return value;
};
const observedAt = '2026-11-14T12:00:00.000Z';
it('classifies an inbox navigation splash before reading or persisting messages', async () => {
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn(async () => ({ status: () => 200 })),
    reload: vi.fn(async () => ({ status: () => 200 })),
    url: () => 'https://www.instagram.com/direct/inbox/',
    waitForFunction: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      ),
    evaluate: vi.fn(async () => ({ splash: true })),
  };
  const persist = vi.fn();
  await expect(
    captureInstagramInbox(
      page as unknown as Page,
      20,
      persist,
      async () => {},
      '90001',
    ),
  ).rejects.toMatchObject({
    reason: 'timeout',
    stage: 'navigation',
    screen: 'splash',
  });
  expect(page.reload).toHaveBeenCalledOnce();
  expect(persist).not.toHaveBeenCalled();
  expect(page.goto).toHaveBeenCalledWith(
    'https://www.instagram.com/direct/inbox/',
    expect.objectContaining({ waitUntil: 'domcontentloaded' }),
  );
});
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
// Opaque message-ID format observed in native Chrome Network on 2026-11-15.
// Values are synthetic; repeat-fixture tests do not establish live reload stability.
const opaqueIds = JSON.parse(
  readFileSync(
    new URL('./instagram-message-ids.fixture.json', import.meta.url),
    'utf8',
  ),
) as { incoming: string; outgoing: string };
const opaqueFixture = () => {
  const value = fixture();
  const edges = thread(value).slide_messages.edges;
  edges[0].node.id = opaqueIds.incoming;
  edges[1].node.id = opaqueIds.outgoing;
  return value;
};
const generalFixture = () => {
  const value = opaqueFixture();
  const current = thread(value);
  current.folder = 'GENERAL';
  current.slide_messages.edges.forEach(
    (edge: { node: { id: string } }, i: number) => {
      edge.node.id = String(900000000000020 + i);
    },
  );
  return value;
};
const emptyFixture = () => {
  const value = fixture();
  mailbox(value).threads_by_folder.edges = [];
  return value;
};

it('maps observed true identities, exact text, timestamps and provider IDs', () => {
  const parsed = parseInstagramInbox(fixture(), observedAt)!;
  expect(parsed.skipped).toEqual([]);
  expect(parsed.actors[0]?.fields).toEqual({
    directThread: 'object',
    viewer: 'object',
    viewerId: 'digit_string',
    mailboxId: 'digit_string',
    threadViewerId: 'digit_string',
  });
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

it('preserves observed opaque provider message IDs alongside numeric IDs', () => {
  const parsed = parseInstagramInbox(opaqueFixture(), observedAt)!;
  expect(parsed.skipped).toEqual([]);
  expect(parsed.messages.map((message) => message.externalMessageId)).toEqual([
    opaqueIds.incoming,
    opaqueIds.outgoing,
    '900000000000010',
    '900000000000012',
    '900000000000014',
  ]);
  expect(
    parsed.messages.slice(0, 2).map((message) => message.direction),
  ).toEqual(['in', 'out']);
  parsed.messages.forEach((message) =>
    expect(() =>
      validateSocialInboxMessage('instagram', message),
    ).not.toThrow(),
  );
});
it('reads General and request snippets as separate folder data and marks requests incomplete', () => {
  const general = parseInstagramInbox(generalFixture(), observedAt, 'GENERAL');
  expect(general?.messages).toHaveLength(5);
  expect(general?.skipped).toEqual([]);
  const request = fixture();
  const requestThread = thread(request);
  requestThread.folder = 'REQUESTS';
  requestThread.slide_messages.edges[0].node.igd_snippet = 'Preview only';
  const parsed = parseInstagramInbox(request, observedAt, 'REQUESTS');
  expect(parsed?.messages[0]).toMatchObject({
    body: 'Preview only',
    incomplete: true,
    incompleteReasonUk: 'Запит не відкрито, щоб не позначати прочитаним.',
  });
});
it('rejects malformed, control-containing and oversized message IDs', () => {
  const invalid: unknown[] = [
    null,
    42,
    '',
    'mid.$',
    'MID.$a',
    'mid.$a.b',
    'mid.$a/b',
    'mid.$a b',
    'mid.$a$',
    'mid.$a\u2028',
    'mid.$' + 'a'.repeat(996),
    '1'.repeat(1001),
  ];
  for (const code of [
    ...Array.from({ length: 33 }, (_, index) => index),
    127,
  ]) {
    invalid.push(
      'mid.$a' + String.fromCharCode(code),
      '1' + String.fromCharCode(code),
    );
  }
  for (const id of invalid) {
    const value = fixture();
    thread(value).slide_messages.edges[0].node.id = id;
    const parsed = parseInstagramInbox(value, observedAt)!;
    expect(parsed.skipped).toContain('invalid_message');
    expect(parsed.messages).toHaveLength(4);
  }
});
it.each([
  'thread_id',
  'viewer_id',
  'viewer.id',
  'viewer.interop_messaging_user_fbid',
  'users.0.id',
  'users.0.interop_messaging_user_fbid',
])('does not accept opaque message IDs in the numeric %s namespace', (path) => {
  const value = opaqueFixture();
  const keys = path.split('.');
  const parent = keys
    .slice(0, -1)
    .reduce((node, key) => node[key], thread(value));
  parent[keys.at(-1)!] = opaqueIds.incoming;
  expect(parseInstagramInbox(value, observedAt)?.messages).toEqual([]);
});
it.each(['sender', 'content', 'text', 'timestamp'])(
  'keeps %s guards on messages with opaque IDs',
  (kind) => {
    const value = opaqueFixture();
    const message = thread(value).slide_messages.edges[0].node;
    if (kind === 'sender') message.sender_fbid = opaqueIds.incoming;
    if (kind === 'content') message.content.__typename = 'UnsupportedContent';
    if (kind === 'text') message.content.text_body = 'Different synthetic body';
    if (kind === 'timestamp') message.timestamp_ms = 'invalid';
    const parsed = parseInstagramInbox(value, observedAt)!;
    expect(parsed.skipped).toContain(
      kind === 'sender' ? 'unknown_sender' : 'invalid_message',
    );
    expect(
      parsed.messages.some(
        (message) => message.externalMessageId === opaqueIds.incoming,
      ),
    ).toBe(false);
  },
);

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
  later: unknown[] = initial,
) {
  let listener: ((response: Response) => void) | undefined;
  let currentUrl = '';
  const events: string[] = [];
  let navigations = 0;
  const frame = { url: () => currentUrl };
  const requestFrame = vi.fn(() => frame);
  const requestBodies = new Map<unknown, string>();
  const responseStatuses = new Map<unknown, number>();
  const readJson = vi.fn(async (value: unknown) => value);
  const emptyRoleLocator = {
    count: async () => 0,
    click: vi.fn(async () => {}),
    or: () => ({ count: async () => 0, click: vi.fn(async () => {}) }),
  };
  const emit = (values: unknown[]) =>
    values.forEach((value) =>
      listener?.({
        url: () => url,
        status: () => responseStatuses.get(value) ?? 200,
        request: () => ({
          method: () => 'POST',
          url: () => url,
          frame: requestFrame,
          postData: () =>
            requestBodies.get(value) ??
            (currentUrl.endsWith('/requests/')
              ? 'fb_api_req_friendly_name=PolarisDirectMessageRequestQuery'
              : 'fb_api_req_friendly_name=PolarisDirectInboxQuery'),
        }),
        json: () => readJson(value),
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
      emit(
        target.endsWith('/requests/')
          ? [requestsFixture()]
          : navigations++ === 0
            ? initial
            : later,
      );
      return { status: () => 200 };
    }),
    url: () => currentUrl,
    mainFrame: () => frame,
    waitForTimeout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    getByText: vi.fn(() => ({ filter: () => ({ count: async () => 0 }) })),
    getByRole: vi.fn(() => emptyRoleLocator),
    locator: vi.fn((selector: string) => ({
      filter: () => ({
        count: async () => (selector.startsWith('a[href^="/direct/"]') ? 1 : 0),
      }),
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
    captureInstagramInbox(
      page as unknown as Page,
      100,
      persist,
      assert,
      '900000000000004',
    );
  return {
    page,
    events,
    batches,
    persist,
    assert,
    requestFrame,
    requestBodies,
    responseStatuses,
    readJson,
    emit,
    run,
  };
}

it('deduplicates repeated opaque-ID captures without changing provider identity', async () => {
  const f = browser([opaqueFixture(), opaqueFixture()]);
  expect(await f.run()).toMatchObject({ complete: false });
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0, 0]);
  expect(f.batches[0]?.messages[0]?.externalMessageId).toBe(opaqueIds.incoming);
});

it('ignores the observed unread-count envelope before importing a request-correlated full inbox', async () => {
  const unread = unreadFixture();
  // Envelope-only parsing mistakes the legitimate partial selection for missing actor identity.
  expect(
    parseInstagramInbox(unread, observedAt)?.actors[0]?.fields.viewer,
  ).toBe('missing');
  const f = browser([unread, fixture()]);
  f.requestBodies.set(
    unread,
    'fb_api_req_friendly_name=useIGDSystemFolderUnreadThreadCountQuery',
  );
  const result = await f.run();
  expect(result).toMatchObject({
    complete: false,
    skipped: ['general_folder_unsupported', 'unsupported_query_ignored'],
  });
  expect(f.readJson).not.toHaveBeenCalledWith(unread);
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0]);
  expect(f.batches.at(-1)?.resumeAnchor).toMatchObject({
    folders: { primary: '900000000000018', requests: null },
    activeFolder: 'requests',
  });
});
it.each([
  '',
  'fb_api_req_friendly_name=IGDThreadDetailQuery',
  'fb_api_req_friendly_name=PolarisDirectInboxQuery&fb_api_req_friendly_name=PolarisDirectInboxQuery',
])(
  'cannot establish identity or coverage from unsupported/ambiguous request metadata %s',
  async (payload) => {
    const value = fixture();
    const f = browser([value]);
    f.requestBodies.set(value, payload);
    const result = await f.run();
    expect(result).toMatchObject({
      complete: false,
      skipped: expect.arrayContaining([
        'unsupported_query_ignored',
        'no_verified_mailbox',
      ]),
    });
    expect(f.readJson).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.page.goto).toHaveBeenCalledOnce();
  },
);
it('still rejects the unread-count shape when the request claims the supported full inbox query', async () => {
  const f = browser([unreadFixture(), fixture()]);
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: { actor: { reason: 'actor_shape_unsupported' } },
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it('keeps rate-limit protection on ignored ancillary queries', async () => {
  const unread = unreadFixture();
  const f = browser([unread, fixture()]);
  f.requestBodies.set(
    unread,
    'fb_api_req_friendly_name=useIGDSystemFolderUnreadThreadCountQuery',
  );
  f.responseStatuses.set(unread, 429);
  await expect(f.run()).rejects.toMatchObject({ reason: 'rate_limit' });
  expect(f.persist).not.toHaveBeenCalled();
});

it('waits past an unattributed empty observation and persists a later attributable mailbox', async () => {
  const empty = emptyFixture();
  mailbox(empty).id = '800000000000003'; // An empty observation cannot bind this identity.
  const f = browser([empty]);
  const wait = vi
    .spyOn(f.page, 'waitForTimeout')
    .mockImplementationOnce(async () => {
      expect(f.persist).not.toHaveBeenCalled();
      f.emit([fixture()]);
    });
  expect(await f.run()).toMatchObject({
    complete: false,
    skipped: ['general_folder_unsupported'],
  });
  expect(wait).toHaveBeenCalled();
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0]);
  expect(f.batches[0]?.messages).toEqual(
    parseInstagramInbox(fixture(), f.batches[0]!.messages[0]!.observedAt)!
      .messages,
  );
});

it('rejects a foreign actor after an empty observation before any persistence', async () => {
  const foreign = fixture();
  thread(foreign).viewer.id = '800000000000004';
  thread(foreign).viewer_id = thread(foreign).viewer.id;
  const f = browser([emptyFixture(), foreign]);
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: {
      actor: { reason: 'viewer_mismatch', hasPreviousMailbox: false },
      capture: { parsed: 2, verified: 0, persisted: 0 },
    },
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it('ends empty-only observations at the deadline without verifying, persisting or visiting Requests', async () => {
  vi.useFakeTimers();
  try {
    const f = browser([emptyFixture()]);
    const result = f.run();
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(99);
    expect(f.page.off).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      complete: false,
      reason: 'unsupported_dom',
      skipped: expect.arrayContaining([
        'no_verified_mailbox',
        'requests_and_spam_unverified',
      ]),
    });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.page.goto).toHaveBeenCalledOnce();
    expect(f.page.off).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['pagination', 'partial-error', 'mailbox', 'edges'])(
  'does not accept an empty observation with malformed %s',
  async (kind) => {
    const value = emptyFixture();
    if (kind === 'pagination')
      delete mailbox(value).threads_by_folder.page_info;
    if (kind === 'partial-error') value.errors = [{ message: 'synthetic' }];
    if (kind === 'mailbox') delete mailbox(value).id;
    if (kind === 'edges') delete mailbox(value).threads_by_folder.edges;
    const f = browser([value, fixture()]);
    await expect(f.run()).rejects.toMatchObject({ reason: 'unknown_auth' });
    expect(f.persist).not.toHaveBeenCalled();
  },
);

it('does not let a trailing empty observation close or reset the verified pagination chain', async () => {
  const first = fixture();
  mailbox(first).threads_by_folder.page_info.has_next_page = true;
  const f = browser([first, emptyFixture()], [[fixture()]]);
  expect(await f.run()).toMatchObject({
    complete: false,
    skipped: expect.arrayContaining(['pagination_chain_unverified']),
  });
  expect(f.events).toContain('scroll');
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0, 0]);
});

it('attaches before navigation, serially persists every chunk and deduplicates repeat captures', async () => {
  const f = browser([fixture(), fixture()]);
  expect(await f.run()).toMatchObject({
    complete: false,
    skipped: ['general_folder_unsupported'],
  });
  expect(f.events.slice(0, 2)).toEqual(['listen', 'navigate']);
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0, 0]);
  expect(f.events).toEqual([
    'listen',
    'navigate',
    'persist-start',
    'persist-end',
    'persist-start',
    'persist-end',
    'navigate',
    'persist-start',
    'persist-end',
  ]);
  expect(f.page.off).toHaveBeenCalledOnce();
  expect(f.assert).toHaveBeenCalledTimes(6);
});

it('awaits persistence before bounded inbox scrolling and requires a captured terminal page', async () => {
  const first = fixture();
  mailbox(first).threads_by_folder.page_info.has_next_page = true;
  const f = browser([first], [[fixture()]]);
  expect(await f.run()).toMatchObject({
    complete: false,
    skipped: expect.arrayContaining(['pagination_chain_unverified']),
  });
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
  expect(await f.run()).toMatchObject({
    complete: false,
    skipped: expect.arrayContaining(['pagination_chain_unverified']),
  });
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

it('reports a parsed mailbox blocked by the DOM auth wait without accepting its viewer or persisting', async () => {
  const f = browser([fixture()]);
  const marker = {
    count: async () => 0,
    first: () => ({
      waitFor: async () => {
        throw Object.assign(Error('synthetic timeout'), {
          name: 'TimeoutError',
        });
      },
    }),
  };
  f.page.locator.mockImplementation(() => ({ filter: () => marker }) as never);
  await expect(
    captureInstagramInbox(
      f.page as unknown as Page,
      100,
      f.persist,
      undefined,
      '900000000000004',
    ),
  ).rejects.toMatchObject({
    reason: 'unknown_auth',
    diagnostic: {
      stage: 'capture_auth',
      urlKind: 'inbox',
      errorKind: 'timeout',
      visible: {
        legacyAuth: 0,
        semanticAuth: 0,
        captcha: 0,
        checkpoint: 0,
        login: 0,
      },
      capture: {
        received: 1,
        parsed: 1,
        verified: 0,
        persisted: 0,
        httpStatus: 200,
      },
    },
  });
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.page.off).toHaveBeenCalledOnce();
});

it('distinguishes a navigation auth failure with no captured response', async () => {
  const f = browser([]);
  f.assert.mockRejectedValue(new SocialSessionCheckError('unknown_auth'));
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: {
      stage: 'auth',
      urlKind: 'inbox',
      navigationHttpStatus: 200,
      capture: {
        received: 0,
        parsed: 0,
        verified: 0,
        persisted: 0,
        httpStatus: null,
      },
    },
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it('counts both Inbox and Requests before a final auth failure', async () => {
  const f = browser([fixture()]);
  f.assert.mockImplementation(async () => {
    if (f.batches.length === 2)
      throw new SocialSessionCheckError('unknown_auth');
  });
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: {
      stage: 'auth',
      urlKind: 'requests',
      capture: { received: 2, parsed: 2, verified: 2, persisted: 2 },
    },
  });
  expect(f.batches.map((batch) => batch.messages.length)).toEqual([5, 0]);
});

it('counts parsed Requests without verification when its auth guard fails', async () => {
  const f = browser([fixture()]);
  let requestChecks = 0;
  f.assert.mockImplementation(async () => {
    // Response capture can validate auth before navigation resolves.
    if (f.page.url().endsWith('/requests/') && ++requestChecks === 1)
      throw new SocialSessionCheckError('unknown_auth');
  });
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: {
      stage: 'capture_auth',
      capture: { received: 2, parsed: 2, verified: 1, persisted: 1 },
    },
  });
  expect(f.batches).toHaveLength(1);
});

it.each(['inbox', 'requests'])(
  'reports the %s persistence stage and retains earlier batches',
  async (scope) => {
    const f = browser([fixture()]);
    const persist = f.persist.getMockImplementation()!;
    f.persist.mockImplementation(async (batch) => {
      if (scope === 'inbox' || f.batches.length === 1)
        throw new SocialSessionCheckError('unknown_auth');
      await persist(batch);
    });
    const count = scope === 'inbox' ? 1 : 2;
    await expect(f.run()).rejects.toMatchObject({
      diagnostic: {
        stage: 'persist',
        capture: {
          received: count,
          parsed: count,
          verified: count,
          persisted: count - 1,
        },
      },
    });
    expect(f.batches).toHaveLength(count - 1);
    expect(f.page.off).toHaveBeenCalledOnce();
  },
);

it('delegates account, pinned session and configured timeout to the shared browser factory', async () => {
  const account = {
    id: 'test',
    channel: 'instagram' as const,
    settings: {},
    session: {
      cookies: [
        {
          name: 'ds_user_id',
          value: '900000000000004',
          domain: '.instagram.com',
          path: '/',
        },
      ],
      proxy: { server: 'http://proxy.invalid' },
    } as never,
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
    false,
    { kind: 'inbox', stage: expect.any(Function) },
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
        {
          id: 'test',
          channel,
          settings: {},
          session: { cookies: [] } as never,
        },
        { watermark: null, cycleStartedAt: null, resumeAnchor: null },
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: channel === 'facebook' ? 'session_invalid' : 'unsupported_dom',
    });
  },
);

// Regressions derived from /tmp/sonar101-review-de665ef/review.test.ts.
it('never treats PRIMARY-only evidence as account-wide completion', async () => {
  const f = browser([fixture()]);
  const result = await f.run();
  expect(result.complete).toBe(false);
  expect(result.skipped).toContain('general_folder_unsupported');
});
it('accepts the personal inbox Messages/Requests layout without optional General tabs', async () => {
  const f = browser([fixture()]);
  Object.assign(f.page, {
    evaluate: vi.fn(async () => ({
      messages: true,
      requests: true,
      primary: false,
      general: false,
      outgoing: 0,
      timestamps: 0,
      threadUrls: [],
    })),
  });
  expect((await f.run()).skipped).not.toContain('general_folder_unsupported');
});
it('does not close an unproven history gap with an unrelated terminal response', async () => {
  const first = fixture();
  thread(first).slide_messages.page_info = {
    has_next_page: true,
    end_cursor: 'REQUIRED-NEXT-CURSOR',
  };
  const terminal = fixture();
  thread(terminal).slide_messages.edges = [
    structuredClone(thread(terminal).slide_messages.edges[0]),
  ];
  thread(terminal).slide_messages.edges[0].node.id = '987654321';
  thread(terminal).slide_messages.page_info.end_cursor = 'UNRELATED-TERMINAL';
  const f = browser([first], [], undefined, [terminal]);
  const result = await f.run();
  expect(result.complete).toBe(false);
  expect(result.skipped).toContain('pagination_chain_unverified');
});
it('rejects a second mailbox/viewer before its batch is persisted', async () => {
  const a = fixture(),
    b = fixture();
  mailbox(b).id = '800000000000003';
  thread(b).viewer.interop_messaging_user_fbid = mailbox(b).id;
  thread(b).viewer.id = '800000000000004';
  thread(b).viewer_id = thread(b).viewer.id;
  thread(b).thread_id = '800000000000005';
  thread(b).users[0].username = 'other_account_peer';
  thread(b).slide_messages.edges.forEach(
    (e: { node: { id: string; sender_fbid: string } }, i: number) => {
      e.node.id = String(800000000000010 + i);
      if (e.node.sender_fbid === '900000000000003')
        e.node.sender_fbid = mailbox(b).id;
    },
  );
  const f = browser([a, b]);
  await expect(f.run()).rejects.toMatchObject({
    reason: 'unknown_auth',
    diagnostic: {
      actor: { reason: 'mailbox_changed', hasPreviousMailbox: true },
      capture: { verified: 1, persisted: 1 },
    },
  });
  expect(f.batches).toHaveLength(1);
  expect(f.batches[0]?.messages).toHaveLength(5);
});

it('rejects the first actor when it differs from the authorized session identity', async () => {
  const value = fixture();
  thread(value).viewer.id = '800000000000004';
  thread(value).viewer_id = thread(value).viewer.id;
  const f = browser([value]);
  await expect(f.run()).rejects.toMatchObject({
    reason: 'unknown_auth',
    diagnostic: {
      stage: 'actor',
      capture: { parsed: 1, verified: 0, persisted: 0 },
    },
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it.each([
  'missing-mailbox',
  'missing-edges',
  'viewer-mismatch',
  'actor-mailbox-mismatch',
  'mixed-viewers',
])(
  'reports bounded actor facts for %s before persisting even with a later valid response',
  async (kind) => {
    const value = fixture();
    if (kind === 'missing-mailbox') delete mailbox(value).id;
    if (kind === 'missing-edges') delete mailbox(value).threads_by_folder.edges;
    if (kind === 'viewer-mismatch') thread(value).viewer.id = '800000000000004';
    if (kind === 'actor-mailbox-mismatch')
      thread(value).viewer.interop_messaging_user_fbid = '800000000000003';
    if (kind === 'mixed-viewers') {
      const foreign = structuredClone(
        mailbox(value).threads_by_folder.edges[0],
      );
      foreign.node.as_ig_direct_thread.viewer.id = '800000000000004';
      mailbox(value).threads_by_folder.edges.push(foreign);
    }
    const f = browser([value, fixture()]);
    const reason =
      kind === 'missing-mailbox'
        ? 'mailbox_missing'
        : kind === 'missing-edges'
          ? 'initial_actors_empty'
          : kind === 'actor-mailbox-mismatch'
            ? 'actor_mailbox_mismatch'
            : 'viewer_mismatch';
    const hasActors = !['missing-mailbox', 'missing-edges'].includes(kind);
    const error = await f.run().catch((error) => error);
    expect(error).toMatchObject({
      reason: 'unknown_auth',
      diagnostic: {
        stage: 'actor',
        capture: { received: 2, parsed: 1, verified: 0, persisted: 0 },
        actor: {
          reason,
          hasPreviousMailbox: false,
          hasMailbox: kind !== 'missing-mailbox',
          hasActors,
          emptyEdges: false,
          allViewersMatchExpected: kind === 'actor-mailbox-mismatch',
          anyViewerMatchesExpected: [
            'actor-mailbox-mismatch',
            'mixed-viewers',
          ].includes(kind),
          anyActorMailboxMatchesExpected: false,
          responseMailboxMatchesExpected: false,
          allActorMailboxesMatchResponse:
            hasActors && kind !== 'actor-mailbox-mismatch',
        },
      },
    });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.page.off).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.diagnostic)).not.toMatch(
      /900000|800000|https:|Synthetic|example_peer/,
    );
  },
);

it.each([
  ['thread-missing', 'directThread', 'missing'],
  ['thread-null', 'directThread', 'null'],
  ['viewer-missing', 'viewer', 'missing'],
  ['viewer-null', 'viewer', 'null'],
  ['id-missing', 'viewerId', 'missing'],
  ['id-null', 'viewerId', 'null'],
  ['mailbox-missing', 'mailboxId', 'missing'],
])(
  'distinguishes unsupported %s shape from an evidenced foreign actor without accepting either',
  async (kind, field, expectedKind) => {
    const value = fixture();
    const edge = mailbox(value).threads_by_folder.edges[0];
    if (kind === 'thread-missing') delete edge.node.as_ig_direct_thread;
    if (kind === 'thread-null') edge.node.as_ig_direct_thread = null;
    if (kind === 'viewer-missing') delete thread(value).viewer;
    if (kind === 'viewer-null') thread(value).viewer = null;
    if (kind === 'id-missing') delete thread(value).viewer.id;
    if (kind === 'id-null') thread(value).viewer.id = null;
    if (kind === 'mailbox-missing')
      delete thread(value).viewer.interop_messaging_user_fbid;
    const f = browser([value, fixture()]);
    const error = await f.run().catch((error) => error);
    expect(error).toMatchObject({
      reason: 'unknown_auth',
      diagnostic: {
        stage: 'actor',
        actor: {
          reason: 'actor_shape_unsupported',
          fields: { [field!]: expectedKind },
        },
        capture: { parsed: 1, verified: 0, persisted: 0 },
      },
    });
    expect(f.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(error.diagnostic)).not.toMatch(
      /900000|https:|Synthetic|example_peer/,
    );
  },
);
it('keeps missing actors in a mixed response fail closed before persisting the valid peer', async () => {
  const value = fixture();
  mailbox(value).threads_by_folder.edges.push({
    node: { as_ig_direct_thread: null },
  });
  const f = browser([value]);
  await expect(f.run()).rejects.toMatchObject({
    diagnostic: { actor: { reason: 'actor_shape_unsupported' } },
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it('distinguishes the messaging namespace matching the expected identity without accepting it as viewer identity', async () => {
  const value = fixture();
  const f = browser([value]);
  await expect(
    captureInstagramInbox(
      f.page as unknown as Page,
      100,
      f.persist,
      f.assert,
      mailbox(value).id,
    ),
  ).rejects.toMatchObject({
    diagnostic: {
      stage: 'actor',
      actor: {
        reason: 'viewer_mismatch',
        allViewersMatchExpected: false,
        anyViewerMatchesExpected: false,
        anyActorMailboxMatchesExpected: true,
        responseMailboxMatchesExpected: true,
        allActorMailboxesMatchResponse: true,
      },
      capture: { verified: 0, persisted: 0 },
    },
  });
  expect(f.persist).not.toHaveBeenCalled();
});
it('rejects a foreign request frame before persisting its response', async () => {
  const f = browser([fixture()]);
  f.requestFrame.mockReturnValue({
    url: () => 'https://www.instagram.com/unrelated-popup/',
  });
  const result = await f.run();
  expect(result.complete).toBe(false);
  expect(result.skipped).toContain('untrusted_response_origin');
  expect(f.persist).not.toHaveBeenCalled();
});
it('retains an earlier committed batch when second-batch persistence fails', async () => {
  const next = fixture();
  thread(next).slide_messages.edges[0].node.id = '123456789';
  const f = browser([fixture(), next]);
  f.persist.mockImplementationOnce(async (batch) => {
    f.batches.push(batch);
  });
  f.persist.mockRejectedValueOnce(new Error('second batch failed'));
  await expect(f.run()).rejects.toThrow('second batch failed');
  expect(f.batches).toHaveLength(1);
  expect(f.batches[0]?.messages).toHaveLength(5);
});
it('preserves full multiline Unicode text independently of snippets and opaque cursors', () => {
  const value = fixture();
  const text = '  Вітаю 👋\n' + 'довгий текст '.repeat(1000) + '\nкінець  ';
  const message = thread(value).slide_messages.edges[0].node;
  message.text_body = text;
  message.content.text_body = text;
  message.igd_snippet = 'truncated';
  expect(parseInstagramInbox(value, observedAt)?.messages[0]?.body).toBe(text);
});
it('accepts only the observed empty Requests/spam coverage for the pinned mailbox', () => {
  const value = requestsFixture();
  expect(parseInstagramRequests(value, '900000000000003')).toBe(true);
  expect(parseInstagramRequests(value, '800000000000003')).toBe(false);
  value.data.spamMailbox.threads_by_folder.edges.push({ node: {} });
  expect(parseInstagramRequests(value, '900000000000003')).toBe(false);
});
it('refuses to open a context when authorized ds_user_id is missing', async () => {
  const withPage = vi.fn();
  const adapter = createSocialInboxAdapter(async () => 100, {
    withPage,
  } as unknown as Parameters<typeof createSocialInboxAdapter>[1]);
  await expect(
    adapter.sync(
      {
        id: 'test',
        channel: 'instagram',
        settings: {},
        session: {
          cookies: [],
          proxy: { server: 'http://proxy.invalid' },
        } as never,
      },
      { watermark: null, cycleStartedAt: null, resumeAnchor: null },
      async () => {},
    ),
  ).rejects.toMatchObject({
    reason: 'unknown_auth',
    diagnostic: { stage: 'identity', capture: { received: 0 } },
  });
  expect(withPage).not.toHaveBeenCalled();
});

it.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'reads offline Instagram folders and request previews without opening a request',
  async () => {
    const { chromium } = await import('playwright');
    const instance = await chromium.launch({
      headless: true,
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    try {
      const context = await instance.newContext({ serviceWorkers: 'block' });
      const queries: string[] = [];
      const navigations: string[] = [];
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== 'https://www.instagram.com')
          return route.abort('blockedbyclient');
        if (url.pathname === '/api/graphql') {
          const name = new URLSearchParams(
            route.request().postData() ?? '',
          ).get('fb_api_req_friendly_name');
          const requestData = new URLSearchParams(
            route.request().postData() ?? '',
          );
          const folder = requestData.get('folder');
          const body =
            name === 'useIGDSystemFolderUnreadThreadCountQuery'
              ? unreadFixture()
              : name === 'PolarisDirectInboxQuery'
                ? folder === 'GENERAL'
                  ? generalFixture()
                  : opaqueFixture()
                : name === 'PolarisDirectMessageRequestQuery'
                  ? requestPreviewFixture()
                  : null;
          if (!body) return route.abort('blockedbyclient');
          queries.push(name!);
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
          });
        }
        navigations.push(url.pathname);
        if (!['/direct/inbox/', '/direct/requests/'].includes(url.pathname))
          return route.abort('blockedbyclient');
        const names =
          url.pathname === '/direct/inbox/'
            ? [
                'useIGDSystemFolderUnreadThreadCountQuery',
                'PolarisDirectInboxQuery',
              ]
            : ['PolarisDirectMessageRequestQuery'];
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<nav><a href="/direct/inbox/">Inbox</a></nav>${url.pathname === '/direct/inbox/' ? folderTabsFixture : ''}<script>(async () => {for (const name of ${JSON.stringify(names)}) await fetch('/api/graphql', {method:'POST', body: new URLSearchParams({fb_api_req_friendly_name:name,folder:'PRIMARY'})});const tab=document.querySelector('[role=tab]:nth-of-type(2)');if(tab)tab.onclick=()=>fetch('/api/graphql',{method:'POST',body:new URLSearchParams({fb_api_req_friendly_name:'PolarisDirectInboxQuery',folder:'GENERAL'})});})()</script>`,
        });
      });
      const page = await context.newPage();
      const batches: SocialInboxBatch[] = [];
      const result = await captureInstagramInbox(
        page,
        3000,
        async (batch) => {
          batches.push(batch);
        },
        undefined,
        '900000000000004',
      );
      expect(queries).toEqual([
        'useIGDSystemFolderUnreadThreadCountQuery',
        'PolarisDirectInboxQuery',
        'PolarisDirectInboxQuery',
        'PolarisDirectMessageRequestQuery',
      ]);
      expect(result).toMatchObject({
        complete: false,
        skipped: ['unsupported_query_ignored'],
      });
      expect(batches.map((batch) => batch.messages.length)).toEqual([5, 5, 1]);
      expect(batches[0]?.messages[0]?.externalMessageId).toBe(
        opaqueIds.incoming,
      );
      expect(batches.at(-1)?.messages[0]).toMatchObject({
        body: 'Preview only',
        incomplete: true,
        incompleteReasonUk: 'Запит не відкрито, щоб не позначати прочитаним.',
      });
      expect(navigations).toEqual(['/direct/inbox/', '/direct/requests/']);
      expect(batches.at(-1)?.resumeAnchor).toMatchObject({
        folders: {
          primary: '900000000000018',
          general: '900000000000018',
          requests: '900000000000018',
        },
        activeFolder: 'requests',
      });
    } finally {
      await instance.close();
    }
  },
  10000,
);
