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
