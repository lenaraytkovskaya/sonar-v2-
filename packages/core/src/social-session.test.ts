import { describe, expect, it } from 'vitest';
import {
  encryptSocialCookies,
  normalizeSocialCookies,
  resolveSocialSession,
  SocialSendError,
  socialProxyFingerprint,
  socialSessionProxies,
  socialProxyList,
} from './social-session.js';

const secret = 'social-test-auth-secret-with-at-least-32-characters';
const raw = JSON.stringify([
  {
    name: 'sessionid',
    value: 'private-session-cookie',
    domain: '.instagram.com',
    path: '/',
    session: true,
    sameSite: 'no_restriction',
    secure: true,
    httpOnly: true,
  },
]);
const proxyUrls =
  'http://user:secret@proxy.example:8000,http://other.example:8000';
function account() {
  return {
    channel: 'instagram' as const,
    settings: {
      cookiesEncrypted: encryptSocialCookies(raw, 'instagram', secret),
      proxyIndex: 0,
      proxyFingerprint: socialProxyFingerprint(
        socialSessionProxies(proxyUrls)[0]!,
      ),
    },
  };
}
describe('social session secrets and fixed proxy binding', () => {
  it('normalizes Cookie-Editor JSON and authenticates encrypted session cookies', () => {
    const value = account();
    expect(value.settings.cookiesEncrypted).not.toContain(
      'private-session-cookie',
    );
    const session = resolveSocialSession(value, secret, proxyUrls);
    expect(session.cookies[0]).toMatchObject({
      name: 'sessionid',
      expires: -1,
      sameSite: 'None',
      domain: '.instagram.com',
    });
    expect(session.proxy).toEqual({
      server: 'http://proxy.example:8000',
      username: 'user',
      password: 'secret',
    });
    expect(() =>
      resolveSocialSession(
        value,
        'another-auth-secret-at-least-32-characters',
        proxyUrls,
      ),
    ).toThrow(SocialSendError);
    value.settings.cookiesEncrypted += 'broken';
    expect(() => resolveSocialSession(value, secret, proxyUrls)).toThrow(
      SocialSendError,
    );
  });
  it('rejects unrelated domains, invalid fields and ambiguous duplicates', () => {
    const source = JSON.parse(raw)[0];
    for (const changes of [
      { domain: '.instagram.com.evil.test' },
      { domain: '.facebook.com' },
      { name: 'bad cookie' },
      { path: 3 },
      { secure: 'true' },
      { expirationDate: '123', session: false },
      { sameSite: 'unknown' },
    ])
      expect(() =>
        normalizeSocialCookies(
          JSON.stringify([{ ...source, ...changes }]),
          'instagram',
        ),
      ).toThrow(SocialSendError);
    expect(() =>
      normalizeSocialCookies(JSON.stringify([source, source]), 'instagram'),
    ).toThrow(SocialSendError);
    for (const value of ['{}', '[]', 'null', '{'])
      expect(() => normalizeSocialCookies(value, 'instagram')).toThrow(
        SocialSendError,
      );
  });
  it('rejects missing, reordered and modified pinned proxies without rotation or credential disclosure', () => {
    for (const proxies of [
      '',
      proxyUrls.split(',').reverse().join(','),
      proxyUrls.replace('user:secret', 'user:changed'),
    ]) {
      expect(() => resolveSocialSession(account(), secret, proxies)).toThrow(
        'Закріплений проксі недоступний або змінений.',
      );
    }
    try {
      resolveSocialSession(
        account(),
        secret,
        'socks://credential:private@example.test:80',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SocialSendError);
      expect(String(error)).not.toMatch(/credential|private|example.test/);
    }
  });
});

describe('socialProxyList', () => {
  it('prefers SOCIAL_PROXY_URLS and reads the IPRoyal file format otherwise', () => {
    expect(socialProxyList({ SOCIAL_PROXY_URLS: 'http://a:b@h:1' })).toBe(
      'http://a:b@h:1',
    );
    const read = () =>
      '# comment\nproxy.example:12321:user@x:p:ss\n\nhttp://u:p@other.example:80\n';
    expect(socialProxyList({ SOCIAL_PROXY_FILE: '/f' }, read)).toBe(
      'http://user%40x:p%3Ass@proxy.example:12321,http://u:p@other.example:80',
    );
    expect(
      socialSessionProxies(
        socialProxyList({ SOCIAL_PROXY_FILE: '/f' }, read),
      )[0],
    ).toMatchObject({
      server: 'http://proxy.example:12321',
      username: 'user@x',
      password: 'p:ss',
    });
    expect(
      socialProxyList({}, () => {
        throw new Error('missing');
      }),
    ).toBe('');
  });
});
