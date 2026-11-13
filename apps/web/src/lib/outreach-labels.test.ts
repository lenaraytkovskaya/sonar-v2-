import { describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
import { channelLabel, socialNetwork } from './outreach-labels';
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
