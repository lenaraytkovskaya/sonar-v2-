import { describe, expect, it } from 'vitest';
import {
  encryptSocialCookies,
  normalizeSocialCookies,
  resolveSocialSession,
  SocialSendError,
  socialProxyFingerprint,
  socialSessionProxies,
  socialProxyList,
  socialAnonymousProxies,
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
function account(cookies = raw) {
  return {
    channel: 'instagram' as const,
    settings: {
      cookiesEncrypted: encryptSocialCookies(cookies, 'instagram', secret),
      proxyIndex: 0,
      proxyFingerprint: socialProxyFingerprint(
        socialSessionProxies(proxyUrls)[0]!,
      ),
    },
  };
}
describe('social session secrets and fixed proxy binding', () => {
  it.each([
    [null, 'Lax'],
    [undefined, 'Lax'],
    ['unspecified', 'Lax'],
    ['strict', 'Strict'],
    ['Strict', 'Strict'],
    ['lax', 'Lax'],
    ['Lax', 'Lax'],
    ['none', 'None'],
    ['None', 'None'],
    ['no_restriction', 'None'],
  ])('normalizes sameSite %s to %s', (sameSite, expected) => {
    const cookies = JSON.stringify([{ ...JSON.parse(raw)[0], sameSite }]);
    expect(normalizeSocialCookies(cookies, 'instagram')[0]?.sameSite).toBe(
      expected,
    );
  });
  it('roundtrips Cookie-Editor sameSite null through encryption and session resolution', () => {
    const cookies = JSON.stringify([{ ...JSON.parse(raw)[0], sameSite: null }]);
    const value = account(cookies);
    expect(value.settings.cookiesEncrypted).not.toContain(
      'private-session-cookie',
    );
    expect(resolveSocialSession(value, secret, proxyUrls).cookies).toEqual(
      normalizeSocialCookies(raw, 'instagram').map((cookie) => ({
        ...cookie,
        sameSite: 'Lax',
      })),
    );
  });
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
      { sameSite: '' },
      { sameSite: 'toString' },
      { sameSite: 0 },
      { sameSite: false },
      { sameSite: {} },
      { sameSite: ['lax'] },
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

it('reserves endpoint aliases without changing account indices, credentials or fingerprints', () => {
  const proxies = socialSessionProxies(
    'http://u:p@RESERVED.example:80,http://p2.example:8000,http://p3.example:8000,http://p4.example:8000,http://p5.example:8000,https://other:auth@reserved.example:80',
  );
  const before = proxies.map(socialProxyFingerprint);
  expect(socialAnonymousProxies(proxies, 0)).toEqual(proxies.slice(1, 5));
  expect(socialAnonymousProxies(proxies, 3)).toEqual(
    proxies.filter((_, index) => index !== 3),
  );
  expect(proxies.map(socialProxyFingerprint)).toEqual(before);
});

it('rebuilds bounded diagnostics without retaining private extra fields', async () => {
  const { safeSocialSessionDiagnostic } = await import('./social-session.js');
  const raw = {
    version: 1,
    stage: 'auth',
    urlKind: 'feed',
    navigationHttpStatus: 403,
    errorKind: 'timeout',
    url: 'https://private.test?secret',
    html: 'private',
    visible: {
      legacyAuth: 999,
      semanticAuth: 2,
      captcha: 0,
      checkpoint: 1,
      login: 0,
      text: 'secret',
    },
  };
  const safe = safeSocialSessionDiagnostic(raw);
  expect(safe).toEqual({
    version: 1,
    stage: 'auth',
    urlKind: 'feed',
    navigationHttpStatus: 403,
    errorKind: 'timeout',
    visible: {
      legacyAuth: 2,
      semanticAuth: 2,
      captcha: 0,
      checkpoint: 1,
      login: 0,
    },
  });
  expect(JSON.stringify(safe)).not.toMatch(/secret|private|https/);
  expect(
    safeSocialSessionDiagnostic({ ...raw, stage: 'secret' }),
  ).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({
      ...raw,
      visible: { ...raw.visible, login: -1 },
    }),
  ).toBeUndefined();
});
