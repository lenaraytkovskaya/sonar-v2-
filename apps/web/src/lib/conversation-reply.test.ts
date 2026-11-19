import { describe, expect, it } from 'vitest';
import {
  canReplyInConversation,
  isReplyDraftChannel,
} from './conversation-reply';

describe('conversation reply channels', () => {
  it.each(['email', 'telegram', 'whatsapp', 'viber'])(
    'shows the reply composer and drafts for %s',
    (channel) => {
      expect(canReplyInConversation(channel)).toBe(true);
      expect(isReplyDraftChannel(channel)).toBe(true);
    },
  );

  it.each(['social', 'form', 'call', 'unknown'])(
    'does not show channel drafts for %s',
    (channel) => {
      expect(isReplyDraftChannel(channel)).toBe(false);
    },
  );

  it('keeps the supported manual reply channels', () => {
    for (const channel of ['social', 'form', 'call'])
      expect(canReplyInConversation(channel)).toBe(true);
    expect(canReplyInConversation('unknown')).toBe(false);
  });
});
