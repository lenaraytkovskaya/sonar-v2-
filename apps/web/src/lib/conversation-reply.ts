export function canReplyInConversation(channel: string) {
  return [
    'form',
    'call',
    'social',
    'email',
    'telegram',
    'whatsapp',
    'viber',
  ].includes(channel);
}

export function isReplyDraftChannel(channel: string) {
  return ['email', 'telegram', 'whatsapp', 'viber'].includes(channel);
}

type ReplyDraft = {
  body: string;
  subject: string;
  requestKey: { key: string; fingerprint: string };
};

export function acceptedReplyDraft(current: ReplyDraft, submitted: ReplyDraft) {
  return current.body === submitted.body &&
    current.subject === submitted.subject &&
    current.requestKey.key === submitted.requestKey.key
    ? { ...current, body: '', requestKey: { fingerprint: '', key: '' } }
    : current;
}

/** Clear synchronously on acceptance, including when the composer has unmounted. */
export function clearAcceptedReplyDraft(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  submitted: ReplyDraft,
) {
  try {
    const current = JSON.parse(storage.getItem(key) ?? 'null');
    if (
      current?.requestKey &&
      acceptedReplyDraft(current, submitted) !== current
    )
      storage.removeItem(key);
  } catch {
    /* Storage may be unavailable. Preserve the in-memory result. */
  }
}
