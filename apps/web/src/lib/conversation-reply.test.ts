import { describe, expect, it } from 'vitest';
import {
  canReplyInConversation,
  isReplyDraftChannel,
  acceptedReplyDraft,
  clearAcceptedReplyDraft,
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

describe('accepted conversation reply drafts', () => {
  const submitted = {
    subject: 'Subject',
    body: 'Reply',
    requestKey: { fingerprint: 'reply', key: 'accepted-request' },
  };
  it('clears the composer and retry key only for the accepted draft', () => {
    expect(acceptedReplyDraft(submitted, submitted)).toEqual({
      ...submitted,
      body: '',
      requestKey: { fingerprint: '', key: '' },
    });
  });
  it.each([
    { body: 'New reply' },
    { subject: 'New subject' },
    { requestKey: { fingerprint: 'reply', key: 'new-request' } },
  ])('preserves a newer draft: %j', (change) => {
    const current = { ...submitted, ...change };
    expect(acceptedReplyDraft(current, submitted)).toBe(current);
  });
  it('removes the persisted draft immediately without needing a mounted UI', () => {
    const values = new Map([['conversation', JSON.stringify(submitted)]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
    };
    clearAcceptedReplyDraft(storage, 'conversation', submitted);
    expect(values.size).toBe(0);
    values.set('conversation', JSON.stringify({ ...submitted, body: 'New' }));
    clearAcceptedReplyDraft(storage, 'conversation', submitted);
    expect(JSON.parse(values.get('conversation')!).body).toBe('New');
  });
  it('tolerates unavailable or malformed storage after acceptance', () => {
    expect(() =>
      clearAcceptedReplyDraft(
        {
          getItem: () => {
            throw Error('Storage unavailable');
          },
          removeItem: () => {},
        },
        'conversation',
        submitted,
      ),
    ).not.toThrow();
  });
});
