import type { Page, Request, WebSocket } from 'playwright';

const LIMIT = 1024 * 1024;
const scalar = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const pick = (record: Record<string, unknown>, names: string[]) => {
  const values = [
    ...new Set(names.flatMap((name) => scalar(record[name]) ?? [])),
  ];
  return values.length === 1 ? values[0] : undefined;
};
// Only these schema names may leave memory. Unknown keys can themselves contain
// message text or credentials, so character sanitization alone is insufficient.
const safeKeys = new Set([
  'data',
  'payload',
  'deltas',
  'delta',
  'message',
  'messages',
  'messageMetadata',
  'body',
  'text',
  'message_id',
  'messageId',
  'sender_id',
  'senderId',
  'thread_id',
  'threadId',
  'offline_threading_id',
  'client_message_id',
  'timestamp',
  'timestamp_precise',
  'variables',
  'input',
  'errors',
  'extensions',
  'fb_api_req_friendly_name',
  'doc_id',
]);
export const facebookNetworkPath = (url: string) => {
  try {
    const parsed = new URL(url);
    if (
      !/^(?:[\w-]+\.)*(?:facebook\.com|messenger\.com)$/.test(parsed.hostname)
    )
      return null;
    return /^\/api\/graphql\/?$/.test(parsed.pathname)
      ? '/api/graphql/'
      : /^\/messaging\/send\/?$/.test(parsed.pathname)
        ? '/messaging/send/'
        : '/<redacted>';
  } catch {
    return null;
  }
};
function decode(raw: string): unknown {
  if (raw.length > LIMIT) return null;
  try {
    return JSON.parse(raw.replace(/^for\s*\(;;\);\s*/, ''));
  } catch {
    const lines = raw.split('\n').filter((line) => line.trim());
    if (lines.length > 1) return lines.map((line) => decode(line));
    return null;
  }
}
function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
  depth = 0,
) {
  if (depth > 12) return;
  if (Array.isArray(value))
    for (const child of value.slice(0, 2000)) walk(child, visit, depth + 1);
  else {
    const record = object(value);
    if (record) {
      visit(record);
      for (const [key, child] of Object.entries(record)) {
        if (typeof child !== 'string') walk(child, visit, depth + 1);
        else if (['payload', 'variables', 'data', 'delta'].includes(key))
          walk(decode(child), visit, depth + 1);
      }
    }
  }
}
function recordFields(record: Record<string, unknown>) {
  // Metadata is part of the SAME message record; never combine siblings or
  // inherit a sender/thread from an envelope containing several messages.
  const metadata = object(record.messageMetadata) ?? {};
  const threadKey =
    object(metadata.threadKey) ?? object(record.threadKey) ?? {};
  const sender = object(record.sender) ?? object(record.message_sender) ?? {};
  const body =
    typeof record.body === 'string'
      ? record.body
      : (scalar(object(record.message)?.text) ?? scalar(record.text));
  return {
    invalid: [
      [record.body, object(record.message)?.text, record.text],
      [
        record.message_id,
        record.messageId,
        record.mid,
        metadata.messageId,
        metadata.message_id,
      ],
      [
        record.sender_id,
        record.senderId,
        record.actor_id,
        metadata.actorFbId,
        metadata.senderId,
        sender.id,
      ],
      [
        record.thread_id,
        record.threadId,
        record.thread_fbid,
        threadKey.threadFbId,
        threadKey.otherUserFbId,
      ],
      [
        record.offline_threading_id,
        record.offlineThreadingId,
        record.client_message_id,
        metadata.offlineThreadingId,
      ],
    ].some(
      (values) =>
        new Set(values.map(scalar).filter((value) => value !== undefined))
          .size > 1,
    ),
    body,
    id:
      pick(record, ['message_id', 'messageId', 'mid']) ??
      pick(metadata, ['messageId', 'message_id']),
    own:
      pick(record, ['sender_id', 'senderId', 'actor_id']) ??
      pick(metadata, ['actorFbId', 'senderId']) ??
      scalar(sender.id),
    thread:
      pick(record, ['thread_id', 'threadId', 'thread_fbid']) ??
      pick(threadKey, ['threadFbId', 'otherUserFbId']),
    client:
      pick(record, [
        'offline_threading_id',
        'offlineThreadingId',
        'client_message_id',
      ]) ?? pick(metadata, ['offlineThreadingId']),
    time:
      pick(record, ['timestamp', 'timestamp_ms', 'timestamp_precise']) ??
      pick(metadata, ['timestamp']),
  };
}
export interface FacebookNetworkInput {
  body: string;
  ownId: string;
  threadId?: string;
  knownIds?: string[];
}
export interface FacebookNetworkEvidence {
  externalMessageId: string;
  threadId?: string;
}
export class FacebookSendNetwork {
  private active?: FacebookNetworkInput & {
    at: number;
    clients: Map<string, string | undefined>;
    known: Set<string>;
    evidence: Map<string, FacebookNetworkEvidence>;
  };
  private requests = new WeakSet<Request>();
  private diagnostics: object[] = [];
  private seen = new Set<string>();
  arm(input: FacebookNetworkInput) {
    this.active = {
      ...input,
      at: Date.now(),
      clients: new Map(),
      known: new Set([...this.seen, ...(input.knownIds ?? [])]),
      evidence: new Map(),
    };
    this.diagnostics = [];
    this.requests = new WeakSet();
  }
  stop() {
    this.active = undefined;
  }
  result() {
    const evidence = [...(this.active?.evidence.values() ?? [])];
    return evidence.length === 1 ? evidence[0] : undefined;
  }
  diagnostic() {
    return this.diagnostics;
  }
  private note(
    raw: unknown,
    source: 'response' | 'websocket' | 'request',
    path: string,
    size: number,
    form?: URLSearchParams,
  ) {
    if (!this.active || this.diagnostics.length >= 16) return;
    const keys = Object.keys(object(raw) ?? {})
      .filter((key) => safeKeys.has(key))
      .slice(0, 16);
    let bodyMatched = false;
    walk(raw, (record) => {
      bodyMatched ||= recordFields(record).body === this.active?.body;
    });
    this.diagnostics.push({
      source,
      path,
      ...(source === 'websocket' ? { size } : {}),
      keys,
      bodyMatched,
      ...(form
        ? {
            parameters: ['fb_api_req_friendly_name', 'doc_id'].filter((name) =>
              form.has(name),
            ),
          }
        : {}),
    });
  }
  request(request: Request) {
    const active = this.active;
    if (
      !active ||
      !facebookNetworkPath(request.url()) ||
      request.method() !== 'POST'
    )
      return;
    this.requests.add(request);
    this.outgoing(
      request.postData() ?? '',
      facebookNetworkPath(request.url())!,
    );
  }
  outgoing(raw: string, path = '/api/graphql/') {
    const active = this.active;
    if (!active || raw.length > LIMIT) return;
    const form = new URLSearchParams(raw);
    const parsed = decode(raw) ?? Object.fromEntries(form);
    this.note(parsed, 'request', path, raw.length, form);
    walk(parsed, (record) => {
      const fields = recordFields(record);
      if (
        !fields.invalid &&
        fields.body === active.body &&
        fields.client &&
        (!fields.own || fields.own === active.ownId) &&
        (active.threadId
          ? fields.thread === active.threadId
          : fields.own === active.ownId)
      )
        active.clients.set(fields.client, fields.thread);
    });
  }
  receive(
    raw: string,
    source: 'response' | 'websocket',
    path = '/<redacted>',
    eligible = true,
  ) {
    const parsed = decode(raw);
    this.note(parsed, source, path, raw.length);
    const active = this.active;
    let failed = false;
    walk(parsed, (record) => {
      failed ||=
        Boolean(record.error) ||
        (Array.isArray(record.errors)
          ? record.errors.length > 0
          : Boolean(record.errors)) ||
        record.success === false ||
        ['failed', 'error', 'failure'].includes(
          String(record.status ?? '').toLowerCase(),
        );
    });
    if (failed) return;
    walk(parsed, (record) => {
      const fields = recordFields(record);
      const old = fields.id ? this.seen.has(fields.id) : false;
      if (fields.id) {
        this.seen.add(fields.id);
        if (this.seen.size > 5000)
          this.seen.delete(this.seen.values().next().value!);
      }
      if (
        !active ||
        fields.invalid ||
        !eligible ||
        old ||
        !fields.id ||
        active.known.has(fields.id)
      )
        return;
      // A same-body historical replay in the same thread is still not a send.
      // Require a current timestamp or a captured request's own client token.
      const sameThread = Boolean(
        active.threadId && fields.thread === active.threadId,
      );
      const sameClient = Boolean(
        fields.client &&
        active.clients.has(fields.client) &&
        (active.threadId || active.clients.size === 1),
      );
      if (active.threadId && fields.thread && fields.thread !== active.threadId)
        return;
      const timestamp = Number(fields.time);
      const fresh =
        Number.isFinite(timestamp) &&
        timestamp >= active.at &&
        timestamp <= Date.now() + 1000;
      if (sameClient) {
        const requestThread = active.clients.get(fields.client!);
        if (requestThread && fields.thread && requestThread !== fields.thread)
          return;
        if (
          (fields.body !== undefined && fields.body !== active.body) ||
          (fields.own && fields.own !== active.ownId)
        )
          return;
      } else if (!(
        sameThread &&
        fresh &&
        !fields.invalid &&
        fields.body === active.body &&
        fields.own === active.ownId
      ))
        return;
      active.evidence.set(fields.id, {
        externalMessageId: fields.id,
        threadId:
          fields.thread ??
          active.threadId ??
          (fields.client ? active.clients.get(fields.client) : undefined),
      });
    });
  }
  attach(page: Page) {
    page.on('request', (request) => this.request(request));
    page.on('response', (response) => {
      const path = facebookNetworkPath(response.url());
      const eligible = this.requests.has(response.request());
      const active = this.active;
      if (
        !active ||
        !eligible ||
        !path ||
        response.status() < 200 ||
        response.status() >= 300 ||
        !['fetch', 'xhr'].includes(response.request().resourceType()) ||
        Number(response.headers()['content-length'] ?? 0) > LIMIT
      )
        return;
      // A streaming response must not keep the send waiting, and an old async
      // response must never enter a later arm's evidence window.
      void response
        .text()
        .then((raw) => {
          if (this.active === active)
            this.receive(raw, 'response', path, eligible);
        })
        .catch(() => {});
    });
    const watch = (socket: WebSocket) => {
      const path = facebookNetworkPath(socket.url());
      if (!path) return;
      socket.on('framesent', (frame) => {
        const raw =
          typeof frame.payload === 'string'
            ? frame.payload
            : frame.payload.toString('utf8');
        this.outgoing(raw, path);
      });
      socket.on('framereceived', (frame) => {
        const raw =
          typeof frame.payload === 'string'
            ? frame.payload
            : frame.payload.toString('utf8');
        if (Buffer.isBuffer(frame.payload)) {
          if (this.active && this.diagnostics.length < 16)
            this.diagnostics.push({
              source: 'websocket',
              path,
              size: frame.payload.length,
              keys: [],
              bodyMatched: false,
            });
        } else this.receive(raw, 'websocket', path);
      });
    };
    page.on('websocket', watch);
  }
}
const trackers = new WeakMap<Page, FacebookSendNetwork>();
export function facebookSendNetwork(page: Page) {
  let tracker = trackers.get(page);
  if (!tracker) {
    tracker = new FacebookSendNetwork();
    tracker.attach(page);
    trackers.set(page, tracker);
  }
  return tracker;
}
