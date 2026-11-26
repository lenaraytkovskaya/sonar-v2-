import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page, WebSocket, Request } from 'playwright';
import {
  FacebookSendNetwork,
  facebookNetworkPath,
} from './facebook-send-network.js';
const input = {
  body: 'Exact  message\ntext',
  ownId: 'self',
  threadId: 'thread',
};
const row = (extra = {}) => ({
  body: input.body,
  messageMetadata: {
    messageId: 'new-id',
    actorFbId: 'self',
    threadKey: { threadFbId: 'thread' },
    timestamp: Date.now(),
  },
  ...extra,
});
const nested = (message: unknown) =>
  JSON.stringify({
    data: { payload: JSON.stringify({ deltas: [{ delta: message }] }) },
  });
describe('Facebook send network evidence', () => {
  it.each(['response', 'websocket'] as const)(
    'accepts nested %s exact own new message and returns provider ID',
    (source) => {
      const tracker = new FacebookSendNetwork();
      tracker.arm(input);
      tracker.receive(nested(row()), source);
      expect(tracker.result()).toEqual({
        externalMessageId: 'new-id',
        threadId: 'thread',
      });
    },
  );
  it.each([
    [
      'incoming',
      { messageMetadata: { ...row().messageMetadata, actorFbId: 'other' } },
    ],
    [
      'foreign thread',
      {
        messageMetadata: {
          ...row().messageMetadata,
          threadKey: { threadFbId: 'foreign' },
        },
      },
    ],
    [
      'old replay',
      { messageMetadata: { ...row().messageMetadata, timestamp: 1 } },
    ],
    [
      'missing time and correlation',
      { messageMetadata: { ...row().messageMetadata, timestamp: undefined } },
    ],
    ['different whitespace', { body: 'Exact message text' }],
  ])('rejects %s', (_name, extra) => {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.receive(nested(row(extra)), 'websocket');
    expect(tracker.result()).toBeUndefined();
  });
  it('rejects observed IDs, sibling borrowing and request started before arm', () => {
    const tracker = new FacebookSendNetwork();
    tracker.receive(nested(row()), 'websocket');
    tracker.arm(input);
    tracker.receive(nested(row()), 'websocket');
    tracker.receive(
      nested({
        body: input.body,
        message: {
          message_id: 'id-2',
          sender_id: 'self',
          thread_id: 'thread',
          timestamp: Date.now(),
        },
      }),
      'response',
    );
    tracker.receive(
      nested(
        row({
          messageMetadata: { ...row().messageMetadata, messageId: 'id-3' },
        }),
      ),
      'response',
      '/api/graphql/',
      false,
    );
    expect(tracker.result()).toBeUndefined();
  });
  it('correlates same-record own request offline token with a new ACK mid without body', () => {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.outgoing(
      new URLSearchParams({
        variables: JSON.stringify({
          input: {
            body: input.body,
            actor_id: 'self',
            thread_id: 'thread',
            offline_threading_id: 'client',
          },
        }),
      }).toString(),
    );
    tracker.receive(
      nested({ mid: 'provider-mid', offline_threading_id: 'client' }),
      'websocket',
    );
    expect(tracker.result()).toEqual({
      externalMessageId: 'provider-mid',
      threadId: 'thread',
    });
  });
  it.each(['foreign', 'self'])(
    'rejects token ACK with a conflicting %s body or thread',
    (own) => {
      const tracker = new FacebookSendNetwork();
      tracker.arm(input);
      tracker.outgoing(
        JSON.stringify({
          ...input,
          sender_id: 'self',
          thread_id: 'thread',
          offline_threading_id: 'client',
        }),
      );
      tracker.receive(
        nested({
          mid: 'provider-mid',
          offline_threading_id: 'client',
          sender_id: own,
          body: 'other',
          thread_id: 'foreign',
        }),
        'websocket',
      );
      expect(tracker.result()).toBeUndefined();
    },
  );
  it('does not decode message bodies as envelopes', () => {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.receive(nested({ body: JSON.stringify(row()) }), 'websocket');
    expect(tracker.result()).toBeUndefined();
  });
  it('keeps diagnostics safe for hostile keys, URLs, parameter values and malformed frames', () => {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.outgoing(
      new URLSearchParams({
        fb_api_req_friendly_name: 'SECRET',
        doc_id: 'SECRET',
        variables: JSON.stringify({ body: input.body, SECRET: 'SECRET' }),
      }).toString(),
    );
    tracker.receive(
      JSON.stringify({ SECRET: 'SECRET', body: input.body }),
      'websocket',
    );
    tracker.receive('SECRET', 'websocket');
    const diagnostics = JSON.stringify(tracker.diagnostic());
    expect(diagnostics).not.toContain('SECRET');
    expect(diagnostics).not.toContain(input.body);
    expect(diagnostics).toContain('fb_api_req_friendly_name');
    expect(diagnostics).toContain('bodyMatched');
    expect(
      facebookNetworkPath(
        'https://www.facebook.com/messages/t/SECRET/?token=SECRET',
      ),
    ).toBe('/<redacted>');
    expect(facebookNetworkPath('https://evil.example/api/graphql/')).toBeNull();
  });
  it('observes frames on a socket opened before arming and removes later send eligibility on stop', () => {
    const page = new EventEmitter();
    const socket = new EventEmitter();
    Object.assign(socket, {
      url: () => 'wss://edge-chat.facebook.com/chat?SECRET',
    });
    const tracker = new FacebookSendNetwork();
    tracker.attach(page as unknown as Page);
    page.emit('websocket', socket as unknown as WebSocket);
    tracker.arm(input);
    socket.emit('framereceived', { payload: nested(row()) });
    expect(tracker.result()?.externalMessageId).toBe('new-id');
    tracker.stop();
    expect(tracker.result()).toBeUndefined();
  });
  it('does not carry a delayed HTTP response across arming', async () => {
    const page = new EventEmitter();
    const tracker = new FacebookSendNetwork();
    tracker.attach(page as unknown as Page);
    let release!: (text: string) => void;
    const request = {
      url: () => 'https://www.facebook.com/api/graphql/',
      method: () => 'POST',
      postData: () => '',
      resourceType: () => 'fetch',
    } as unknown as Request;
    tracker.arm(input);
    page.emit('request', request);
    page.emit('response', {
      url: () => 'https://www.facebook.com/api/graphql/',
      status: () => 200,
      request: () => request,
      headers: () => ({}),
      text: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    tracker.arm(input);
    release(nested(row()));
    await vi.waitFor(() => expect(tracker.result()).toBeUndefined());
  });
});

it('rejects conflicting aliases, metadata and unsafe numeric IDs even with a captured client', () => {
  for (const conflict of [
    { sender_id: 'foreign', actor_id: 'self' },
    { sender_id: 'self', messageMetadata: { actorFbId: 'foreign' } },
    { thread_id: 'thread', threadId: 'foreign' },
    { mid: 9007199254740992 },
  ]) {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.outgoing(
      JSON.stringify({
        body: input.body,
        sender_id: input.ownId,
        thread_id: input.threadId,
        offline_threading_id: 'client',
      }),
    );
    tracker.receive(
      JSON.stringify({
        mid: 'new',
        offline_threading_id: 'client',
        ...conflict,
      }),
      'websocket',
    );
    expect(tracker.result()).toBeUndefined();
  }
});
it('binds an unknown-thread ACK to the own request thread and rejects conflicts', () => {
  for (const thread of [undefined, 'foreign']) {
    const tracker = new FacebookSendNetwork();
    tracker.arm({ body: input.body, ownId: input.ownId });
    tracker.outgoing(
      JSON.stringify({
        body: input.body,
        sender_id: input.ownId,
        thread_id: input.threadId,
        offline_threading_id: 'client',
      }),
    );
    tracker.receive(
      JSON.stringify({
        mid: 'new',
        offline_threading_id: 'client',
        thread_id: thread,
      }),
      'websocket',
    );
    if (thread) expect(tracker.result()).toBeUndefined();
    else
      expect(tracker.result()).toEqual({
        externalMessageId: 'new',
        threadId: input.threadId,
      });
  }
});
it('rejects delayed response headers belonging to an earlier arm', async () => {
  const page = new EventEmitter();
  const tracker = new FacebookSendNetwork();
  tracker.attach(page as unknown as Page);
  const request = {
    url: () => 'https://www.facebook.com/api/graphql/',
    method: () => 'POST',
    postData: () => '',
    resourceType: () => 'fetch',
  } as unknown as Request;
  tracker.arm(input);
  page.emit('request', request);
  tracker.arm(input);
  const read = vi.fn(async () => nested(row()));
  page.emit('response', {
    url: request.url,
    status: () => 200,
    request: () => request,
    headers: () => ({}),
    text: read,
  });
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  expect(tracker.result()).toBeUndefined();
});

it.each(['errors', 'error', 'failed'])(
  'does not treat a negative %s envelope as confirmation',
  (mode) => {
    const tracker = new FacebookSendNetwork();
    tracker.arm(input);
    tracker.outgoing(
      JSON.stringify({
        body: input.body,
        sender_id: input.ownId,
        thread_id: input.threadId,
        offline_threading_id: 'client',
      }),
    );
    const ack = { mid: 'provider-id', offline_threading_id: 'client' };
    tracker.receive(
      JSON.stringify(
        mode === 'errors'
          ? { data: ack, errors: [{ extensions: ack }] }
          : mode === 'error'
            ? { error: { payload: ack } }
            : { status: 'failed', payload: ack },
      ),
      'response',
    );
    expect(tracker.result()).toBeUndefined();
  },
);
