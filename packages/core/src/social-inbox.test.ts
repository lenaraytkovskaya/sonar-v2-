import { expect, it } from 'vitest';
import {
  canonicalSocialPeer,
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
