import { describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
import {
  channelLabel,
  socialNetwork,
  messageStatus,
  facebookHistoryLink,
} from './outreach-labels';
import { uk } from '../i18n/uk';

describe('social contact labels', () => {
  it.each([
    ['https://www.instagram.com/example.company/', 'instagram'],
    ['https://INSTAGRAM.com/example.company/', 'instagram'],
    ['https://www.facebook.com/example.company/', 'facebook'],
    ['https://m.facebook.com/profile.php?id=123', 'facebook'],
    ['https://mbasic.facebook.com/example.company/', 'facebook'],
    ['https://fb.me/example.company', 'facebook'],
    ['https://fb.com/example.company', 'facebook'],
    ['https://www.linkedin.com/company/example-company/', 'linkedin'],
    ['https://linkedin.com/in/example-person/', 'linkedin'],
  ] as const)('identifies %s', (value, network) => {
    expect(socialNetwork(value)).toBe(network);
    expect(channelLabel('social', value)).toBe(uk.social.networks[network]);
  });

  it.each([
    '',
    '@example.company',
    'not a URL',
    'https://example.com/instagram.com/example.company/',
    'https://instagram.com.example.com/example.company/',
    'https://fakeinstagram.com/example.company/',
    'https://instagram.com@example.com/',
    'https://user:password@instagram.com/example.company/',
    'javascript:instagram.com/example.company/',
    'ftp://instagram.com/example.company/',
    'https://constructor/',
  ])('keeps the generic label for %s', (value) => {
    expect(socialNetwork(value)).toBeNull();
    expect(channelLabel('social', value)).toBe(uk.outreach.social);
  });

  it('only specializes social channels', () => {
    expect(channelLabel('social')).toBe(uk.outreach.social);
    expect(
      channelLabel('email', 'https://instagram.com/example.company/'),
    ).toBe(uk.email.title);
    expect(channelLabel('unknown')).toBe('unknown');
  });
});

it('shows the honest FB outcome and stored link while leaving verified channels unchanged', () => {
  const message = {
    channel: 'social',
    toValue: 'https://www.facebook.com/example/',
    reasonUk: uk.outreach.facebookDispatched,
    providerId: 'https://www.facebook.com/example/',
  };
  expect(messageStatus('sent', message)).toBe('Відправлено, перевірте в чаті');
  expect(facebookHistoryLink('sent', message)).toBe(message.providerId);
  expect(messageStatus('failed', message)).toBe(uk.email.statuses.failed);
  expect(
    messageStatus('sent', {
      ...message,
      toValue: 'https://www.instagram.com/example/',
    }),
  ).toBe(uk.email.statuses.sent);
  for (const channel of ['email', 'telegram', 'whatsapp'])
    expect(messageStatus('sent', { ...message, channel })).toBe(
      uk.email.statuses.sent,
    );
  expect(
    facebookHistoryLink('sent', {
      ...message,
      providerId: 'javascript:alert(1)',
    }),
  ).toBeNull();
  expect(facebookHistoryLink('failed', message)).toBeNull();
});
