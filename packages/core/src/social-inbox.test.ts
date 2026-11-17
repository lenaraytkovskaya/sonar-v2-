import { expect, it } from 'vitest';
import {
  canonicalSocialPeer,
  isNewSocialInboxMessage,
  validateSocialInboxMessage,
} from './social-inbox.js';
it('canonicalizes provider profiles and rejects inbox URLs as peer identities', () => {
  expect(
    canonicalSocialPeer(
      'instagram',
      'https://instagram.com/Example/?utm_source=x',
    ),
  ).toBe('https://www.instagram.com/example/');
  expect(
    canonicalSocialPeer(
      'facebook',
      'https://m.facebook.com/profile.php?id=123',
    ),
  ).toBe('https://www.facebook.com/profile.php?id=123');
  expect(
    canonicalSocialPeer('linkedin', 'https://www.linkedin.com/in/Example/'),
  ).toBe('https://www.linkedin.com/in/example/');
  expect(() =>
    canonicalSocialPeer('instagram', 'https://www.instagram.com/direct/t/123/'),
  ).toThrow();
  expect(() =>
    canonicalSocialPeer('instagram', 'https://facebook.com/example'),
  ).toThrow();
});
it('uses per-thread message timestamps as inbox cursors and keeps equal-time new IDs', () => {
  const message = {
    externalMessageId: 'message-2',
    threadId: 'thread-1',
    direction: 'in' as const,
    senderProfile: 'https://instagram.com/peer/',
    peerProfile: 'https://instagram.com/peer/',
    body: 'hello',
    occurredAt: '2026-11-16T10:00:00.000Z',
    observedAt: '2026-11-16T10:00:01.000Z',
  };
  const cursor = {
    lastMessageAt: '2026-11-16T10:00:00.000Z',
    lastMessageIds: ['message-1'],
  };
  expect(isNewSocialInboxMessage(message, cursor)).toBe(true);
  expect(
    isNewSocialInboxMessage(
      { ...message, occurredAt: '2026-11-16T09:59:59.000Z' },
      cursor,
    ),
  ).toBe(false);
  expect(
    isNewSocialInboxMessage(
      { ...message, externalMessageId: 'message-1' },
      cursor,
    ),
  ).toBe(false);
});
it('requires provider IDs and actual timestamps without synthesizing identities', () => {
  const message = {
    externalMessageId: '',
    threadId: 'thread',
    direction: 'in' as const,
    senderProfile: 'https://instagram.com/peer/',
    peerProfile: 'https://instagram.com/peer/',
    body: 'Hello',
    occurredAt: '2026-11-14T10:00:00Z',
    observedAt: '2026-11-14T10:01:00Z',
  };
  expect(() => validateSocialInboxMessage('instagram', message)).toThrow(
    'стабільний ID',
  );
  expect(() =>
    validateSocialInboxMessage('instagram', {
      ...message,
      externalMessageId: '_r_1h_',
    }),
  ).toThrow('стабільний ID');
  expect(() =>
    validateSocialInboxMessage('instagram', {
      ...message,
      externalMessageId: 'provider-123',
      occurredAt: 'unknown',
    }),
  ).toThrow('Некоректне');
});

it('allows an observed Instagram outgoing sender ID when the provider omits its profile handle', () => {
  const message = {
    externalMessageId: '123',
    threadId: '456',
    direction: 'out' as const,
    senderPlatformId: '789',
    peerProfile: 'https://instagram.com/peer/',
    body: 'Hello',
    occurredAt: '2026-11-14T10:00:00Z',
    observedAt: '2026-11-14T10:01:00Z',
  };
  expect(
    validateSocialInboxMessage('instagram', message).senderProfile,
  ).toBeUndefined();
  expect(() =>
    validateSocialInboxMessage('instagram', {
      ...message,
      senderPlatformId: '',
    }),
  ).toThrow();
  expect(() =>
    validateSocialInboxMessage('instagram', { ...message, direction: 'in' }),
  ).toThrow();
  expect(() => validateSocialInboxMessage('facebook', message)).toThrow();
});

it('preserves an unknown Facebook calendar time only with an explicit provider label and independent observation', () => {
  const message = {
    externalMessageId: '1@msgr.2',
    threadId: '3',
    direction: 'in' as const,
    senderProfile: 'https://facebook.com/123/',
    peerProfile: 'https://facebook.com/123/',
    body: 'Reply',
    occurredAt: null,
    providerTimestamp: 'Saturday 16:45',
    observedAt: '2026-11-15T02:00:00Z',
  };
  expect(validateSocialInboxMessage('facebook', message)).toMatchObject({
    occurredAt: null,
    providerTimestamp: 'Saturday 16:45',
  });
  expect(() =>
    validateSocialInboxMessage('facebook', {
      ...message,
      providerTimestamp: undefined,
    }),
  ).toThrow();
  expect(() => validateSocialInboxMessage('instagram', message)).toThrow();
});
