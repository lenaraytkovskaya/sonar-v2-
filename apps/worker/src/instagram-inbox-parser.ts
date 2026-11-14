import {
  canonicalSocialPeer,
  type SocialInboxMessage,
} from '@sonar/core/social-inbox';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digits = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,1000}$/.test(value);
function pagination(value: unknown) {
  const page = object(value);
  return typeof page.has_next_page === 'boolean' &&
    (page.end_cursor === null || typeof page.end_cursor === 'string') &&
    (!page.has_next_page || Boolean(page.end_cursor))
    ? { more: page.has_next_page, cursor: page.end_cursor as string | null }
    : null;
}
export type InstagramInboxPage = {
  messages: SocialInboxMessage[];
  inbox: ReturnType<typeof pagination>;
  threads: { id: string; url: string; page: ReturnType<typeof pagination> }[];
  skipped: string[];
};
/** Only the captured SlideMailbox shape is supported. Snippets are never source text. */
export function parseInstagramInbox(
  value: unknown,
  observedAt: string,
): InstagramInboxPage | null {
  const mailbox = object(
    object(object(value).data).get_slide_mailbox_for_iris_subscription,
  );
  if (!Object.keys(mailbox).length) return null;
  const connection = object(mailbox.threads_by_folder);
  const result: InstagramInboxPage = {
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
    const thread = object(object(object(edge).node).as_ig_direct_thread);
    if (thread.is_group === true) {
      result.skipped.push('group_unsupported');
      continue;
    }
    const viewer = object(thread.viewer);
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
      const text =
        typeof message.text_body === 'string'
          ? message.text_body
          : content.text_body;
      const timestamp = digits(message.timestamp_ms)
        ? Number(message.timestamp_ms)
        : NaN;
      if (
        !direction ||
        !digits(message.id) ||
        message.__typename !== 'SlideMessage' ||
        message.content_type !== 'TEXT' ||
        content.__typename !== 'SlideMessageText' ||
        typeof text !== 'string' ||
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
        body: text,
        occurredAt: new Date(timestamp).toISOString(),
        observedAt,
      });
    }
  }
  return result;
}
