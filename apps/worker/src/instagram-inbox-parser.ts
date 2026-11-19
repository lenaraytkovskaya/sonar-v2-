import {
  canonicalSocialPeer,
  type SocialInboxMessage,
} from '@sonar/core/social-inbox';
import type {
  SocialActorFieldKind,
  SocialActorFields,
} from '@sonar/core/social-session';
import type { Page } from 'playwright';

/** Screenshot-derived UI markers aid traversal; they never prove message identity. */
export async function readInstagramInboxDom(page: Page) {
  return page.evaluate(() => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible' &&
      !node.closest('[hidden],[aria-hidden="true"],[inert]');
    const labels = {
      messages: /^(?:Messages|Повідомлення|Сообщения)$/i,
      requests: /^(?:Requests|Запити|Запросы)(?:\s*\(\d+\))?$/i,
      primary: /^(?:Primary|Основні|Основные)$/i,
      general: /^(?:General|Загальні|Общие)$/i,
      outgoing: /^(?:You sent|Ви надіслали|Вы отправили)(?:\b|:|\s|$)/i,
      timestamp:
        /^(?:\d+[mhdw]|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}:\d{2}\s*(?:AM|PM)|[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)|(?:Today|Yesterday|Сьогодні|Вчора|Сегодня|Вчера)(?:\s+\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)?)$/i,
    };
    const markers = {
      messages: false,
      requests: false,
      primary: false,
      general: false,
      outgoing: 0,
      timestamps: 0,
    };
    const threadUrls = new Set<string>();
    const nodes = document.querySelectorAll(
      'a[href],button,[role="button"],[role="tab"],[role="heading"],h1,h2,h3,[aria-label],time,span',
    );
    for (const node of Array.from(nodes).slice(0, 1000)) {
      if (!visible(node)) continue;
      const label = (
        node.getAttribute('aria-label') ??
        node.textContent ??
        ''
      ).trim();
      for (const key of ['messages', 'requests', 'primary', 'general'] as const)
        if (labels[key].test(label)) markers[key] = true;
      if (labels.outgoing.test(label)) markers.outgoing++;
      if (
        labels.timestamp.test(label) ||
        (node.tagName === 'TIME' &&
          Number.isFinite(Date.parse(node.getAttribute('datetime') ?? '')))
      )
        markers.timestamps++;
      if (node.tagName !== 'A') continue;
      try {
        const url = new URL(node.getAttribute('href')!, location.href);
        if (
          url.origin === 'https://www.instagram.com' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /^\/direct\/t\/\d+\/?$/.test(url.pathname)
        )
          threadUrls.add(url.href);
      } catch {
        /* Ignore malformed and foreign links. */
      }
    }
    return { ...markers, threadUrls: [...threadUrls] };
  });
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digits = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,1000}$/.test(value);
// Message IDs use their own provider namespace; actor/thread IDs stay numeric.
const messageId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:\d{1,1000}|mid\.\$[A-Za-z0-9_-]{1,995})$/.exec(value)?.[0] === value;
const fieldKind = (value: unknown): SocialActorFieldKind =>
  value === undefined
    ? 'missing'
    : value === null
      ? 'null'
      : digits(value)
        ? 'digit_string'
        : typeof value === 'object' && !Array.isArray(value)
          ? 'object'
          : 'other';
function pagination(value: unknown) {
  const page = object(value);
  return typeof page.has_next_page === 'boolean' &&
    (page.end_cursor === null || typeof page.end_cursor === 'string') &&
    (!page.has_next_page || Boolean(page.end_cursor))
    ? { more: page.has_next_page, cursor: page.end_cursor as string | null }
    : null;
}
export type InstagramInboxPage = {
  mailboxId: string | null;
  emptyEdges: boolean;
  actors: {
    viewerId: unknown;
    mailboxId: unknown;
    fields: SocialActorFields;
  }[];
  messages: SocialInboxMessage[];
  inbox: ReturnType<typeof pagination>;
  threads: { id: string; url: string; page: ReturnType<typeof pagination> }[];
  skipped: string[];
};
/** Only the captured SlideMailbox shape is supported. Snippets are never source text. */
export function parseInstagramInbox(
  value: unknown,
  observedAt: string,
  expectedFolder: 'PRIMARY' | 'GENERAL' | 'REQUESTS' = 'PRIMARY',
): InstagramInboxPage | null {
  const mailbox = object(
    object(object(value).data).get_slide_mailbox_for_iris_subscription,
  );
  if (!Object.keys(mailbox).length) return null;
  const connection = object(mailbox.threads_by_folder);
  const result: InstagramInboxPage = {
    mailboxId: digits(mailbox.id) ? mailbox.id : null,
    emptyEdges:
      Array.isArray(connection.edges) && connection.edges.length === 0,
    actors: [],
    messages: [],
    inbox: pagination(connection.page_info),
    threads: [],
    skipped: [],
  };
  if (
    Array.isArray(object(value).errors) &&
    (object(value).errors as unknown[]).length
  )
    result.skipped.push('graphql_partial_error');
  if (!Array.isArray(connection.edges) || !digits(mailbox.id)) {
    result.skipped.push('invalid_mailbox');
    return result;
  }
  for (const edge of connection.edges) {
    const rawThread = object(object(edge).node).as_ig_direct_thread;
    const thread = object(rawThread);
    const viewer = object(thread.viewer);
    result.actors.push({
      viewerId: viewer.id,
      mailboxId: viewer.interop_messaging_user_fbid,
      fields: {
        directThread: fieldKind(rawThread),
        viewer: fieldKind(thread.viewer),
        viewerId: fieldKind(viewer.id),
        mailboxId: fieldKind(viewer.interop_messaging_user_fbid),
        threadViewerId: fieldKind(thread.viewer_id),
      },
    });
    if (
      expectedFolder === 'REQUESTS'
        ? !['REQUESTS', 'REQUEST', 'PENDING', 'OTHER'].includes(
            String(thread.folder),
          )
        : thread.folder !== expectedFolder
    ) {
      result.skipped.push('unsupported_folder');
      continue;
    }
    if (thread.is_group === true) {
      result.skipped.push('group_unsupported');
      continue;
    }
    const users = Array.isArray(thread.users) ? thread.users.map(object) : [];
    const peers = users.filter((user) => user.id !== viewer.id);
    const peer = peers[0] ?? {};
    const withoutViewer = Array.isArray(thread.usersWithoutViewer)
      ? thread.usersWithoutViewer.map(object)
      : [];
    if (
      thread.is_group !== false ||
      !digits(thread.thread_id) ||
      !digits(viewer.id) ||
      viewer.id !== thread.viewer_id ||
      !digits(viewer.interop_messaging_user_fbid) ||
      mailbox.id !== viewer.interop_messaging_user_fbid ||
      peers.length !== 1 ||
      !digits(peer.id) ||
      !digits(peer.interop_messaging_user_fbid) ||
      peer.interop_messaging_user_fbid === viewer.interop_messaging_user_fbid ||
      withoutViewer.length !== 1 ||
      withoutViewer[0]?.id !== peer.id ||
      typeof peer.username !== 'string' ||
      !/^[\w.]{1,30}$/.test(peer.username)
    ) {
      result.skipped.push('ambiguous_thread_identity');
      continue;
    }
    let peerProfile: string;
    try {
      peerProfile = canonicalSocialPeer(
        'instagram',
        `https://www.instagram.com/${peer.username}/`,
      );
    } catch {
      result.skipped.push('invalid_peer');
      continue;
    }
    const threadId = thread.thread_id;
    const threadUrl = `https://www.instagram.com/direct/t/${threadId}/`;
    const messages = object(thread.slide_messages);
    result.threads.push({
      id: threadId,
      url: threadUrl,
      page: pagination(messages.page_info),
    });
    if (!Array.isArray(messages.edges)) {
      result.skipped.push('missing_messages');
      continue;
    }
    for (const messageEdge of messages.edges) {
      const message = object(object(messageEdge).node);
      const content = object(message.content);
      const direction =
        message.sender_fbid === peer.interop_messaging_user_fbid
          ? 'in'
          : message.sender_fbid === viewer.interop_messaging_user_fbid
            ? 'out'
            : null;
      if (expectedFolder === 'REQUESTS' && direction !== 'in') continue;
      const text =
        typeof message.text_body === 'string'
          ? message.text_body
          : content.text_body;
      const preview =
        typeof message.igd_snippet === 'string'
          ? message.igd_snippet
          : content.igd_snippet;
      const timestamp = digits(message.timestamp_ms)
        ? Number(message.timestamp_ms)
        : NaN;
      if (
        !direction ||
        !messageId(message.id) ||
        message.__typename !== 'SlideMessage' ||
        message.content_type !== 'TEXT' ||
        content.__typename !== 'SlideMessageText' ||
        (expectedFolder === 'REQUESTS'
          ? typeof preview !== 'string' || !preview.trim()
          : typeof text !== 'string') ||
        (typeof content.text_body === 'string' && content.text_body !== text) ||
        !Number.isSafeInteger(timestamp) ||
        timestamp <= 0 ||
        !Number.isFinite(new Date(timestamp).getTime())
      ) {
        result.skipped.push(!direction ? 'unknown_sender' : 'invalid_message');
        continue;
      }
      result.messages.push({
        externalMessageId: message.id,
        threadId,
        threadUrl,
        direction,
        senderPlatformId: message.sender_fbid as string,
        ...(direction === 'in' ? { senderProfile: peerProfile } : {}),
        peerProfile,
        body:
          expectedFolder === 'REQUESTS'
            ? (preview as string)
            : (text as string),
        occurredAt: new Date(timestamp).toISOString(),
        observedAt,
        ...(expectedFolder === 'REQUESTS'
          ? {
              incomplete: true,
              incompleteReasonUk:
                'Запит не відкрито, щоб не позначати прочитаним.',
            }
          : {}),
      });
      if (expectedFolder === 'REQUESTS') break;
    }
  }
  return result;
}

/** Only the observed empty Requests + spam response proves coverage here. */
export function parseInstagramRequests(
  value: unknown,
  expectedMailbox: string,
) {
  const data = object(object(value).data);
  const boxes = [
    object(data.get_slide_mailbox_for_iris_subscription),
    object(data.spamMailbox),
  ];
  return (
    !Array.isArray(object(value).errors) &&
    boxes.every((box) => {
      const connection = object(box.threads_by_folder);
      const page = pagination(connection.page_info);
      return (
        box.id === expectedMailbox &&
        Array.isArray(connection.edges) &&
        connection.edges.length === 0 &&
        page?.more === false &&
        page.cursor === null
      );
    })
  );
}
