import { socialTarget, type SocialNetwork } from './social.js';

export type SocialInboxCheckpoint = {
  watermark: string | null;
  resumeAnchor: Record<string, unknown> | null;
  cycleStartedAt: string | null;
};
export type SocialInboxMessage = {
  externalMessageId: string;
  threadId: string;
  direction: 'in' | 'out';
  senderProfile: string;
  peerProfile: string;
  body: string;
  occurredAt: string;
  observedAt: string;
  threadUrl?: string;
};
export type SocialInboxBatch = {
  messages: SocialInboxMessage[];
  resumeAnchor: Record<string, unknown> | null;
};

/** Canonical identity only, never display names, generated DOM IDs or message text. */
export function canonicalSocialPeer(network: SocialNetwork, raw: string) {
  const target = socialTarget(raw);
  if (target?.network === network && target.kind !== 'unsupported')
    return target.canonicalUrl;
  // Public LinkedIn person profiles are valid inbox peers, even though the sender
  // currently supports company pages only.
  if (network === 'linkedin') {
    try {
      const url = new URL(raw);
      const match = /^\/in\/([\w-]+)\/?$/.exec(url.pathname);
      if (
        url.protocol === 'https:' &&
        /^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(url.hostname) &&
        !url.username &&
        !url.password &&
        match
      )
        return `https://www.linkedin.com/in/${match[1]!.toLowerCase()}/`;
    } catch {
      /* Invalid identity is rejected below. */
    }
  }
  throw new Error('Некоректний профіль співрозмовника соцмережі.');
}
export function socialPeerHandle(profile: string) {
  const url = new URL(profile);
  return (
    url.searchParams.get('id') ??
    url.pathname.split('/').filter(Boolean).at(-1)!
  );
}
export function validateSocialInboxMessage(
  network: SocialNetwork,
  message: SocialInboxMessage,
) {
  for (const id of [message.externalMessageId, message.threadId])
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id.length > 1000 ||
      /^(?:_r_[a-z\d]+_|:r[a-z\d]+:)$/i.test(id) ||
      /[\p{Cc}]/u.test(id)
    )
      throw new Error(
        'Потрібен стабільний ID повідомлення та діалогу соцмережі.',
      );
  if (
    !['in', 'out'].includes(message.direction) ||
    typeof message.body !== 'string' ||
    message.body.length > 100000 ||
    ![message.occurredAt, message.observedAt].every(
      (value) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) &&
        Number.isFinite(Date.parse(value)),
    )
  )
    throw new Error('Некоректне повідомлення соцмережі.');
  return {
    ...message,
    senderProfile: canonicalSocialPeer(network, message.senderProfile),
    peerProfile: canonicalSocialPeer(network, message.peerProfile),
  };
}
