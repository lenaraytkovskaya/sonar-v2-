import {
  detectSocialActionBlocked,
  SocialSessionCheckError,
} from './social-session.js';
import { describe, expect, it } from 'vitest';
import {
  encryptSocialCookies,
  encryptSocialStorageState,
  encryptSocialProxy,
  generateSocialDevice,
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
  const history = {
    threadList: 0,
    messageRegions: 1,
    messageNodes: 2,
    pinRestore: 1,
    restoreConfirmation: 0,
    historyMissing: 1,
  };
  expect(
    safeSocialSessionDiagnostic({
      ...raw,
      stage: 'restore',
      history: {
        ...history,
        messageNodes: 999,
        url: 'private',
        text: 'secret',
      },
    }),
  ).toEqual({ ...safe, stage: 'restore', history });
  for (const invalid of [-1, 1.5, '1', null, Infinity])
    expect(
      safeSocialSessionDiagnostic({
        ...raw,
        history: { ...history, pinRestore: invalid },
      }),
    ).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({ ...raw, history: null }),
  ).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({
      ...raw,
      visible: { ...raw.visible, login: -1 },
    }),
  ).toBeUndefined();
  const inbox = {
    ...raw,
    stage: 'capture_auth',
    urlKind: 'inbox',
    capture: {
      received: 999,
      parsed: 1,
      verified: 0,
      persisted: 0,
      httpStatus: 200,
      viewerId: 'private',
      url: 'secret',
    },
  };
  expect(safeSocialSessionDiagnostic(inbox)).toEqual({
    ...safe,
    stage: 'capture_auth',
    urlKind: 'inbox',
    capture: {
      received: 2,
      parsed: 1,
      verified: 0,
      persisted: 0,
      httpStatus: 200,
    },
  });
  expect(
    safeSocialSessionDiagnostic({ ...inbox, stage: 'persist' }),
  ).toMatchObject({ stage: 'persist', capture: { received: 2 } });
  expect(
    safeSocialSessionDiagnostic({
      ...inbox,
      capture: { ...inbox.capture, parsed: -1 },
    }),
  ).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({
      ...inbox,
      capture: { ...inbox.capture, httpStatus: 999 },
    }),
  ).toBeUndefined();
  const actor = {
    reason: 'viewer_mismatch',
    hasPreviousMailbox: false,
    hasMailbox: true,
    hasActors: true,
    emptyEdges: false,
    allViewersMatchExpected: false,
    anyViewerMatchesExpected: false,
    anyActorMailboxMatchesExpected: true,
    responseMailboxMatchesExpected: true,
    allActorMailboxesMatchResponse: true,
  };
  const withActor = {
    ...inbox,
    stage: 'actor',
    actor: { ...actor, viewerId: 'private', cookie: 'secret' },
  };
  expect(safeSocialSessionDiagnostic(withActor)?.actor).toEqual(actor);
  const fields = {
    directThread: 'object',
    viewer: 'object',
    viewerId: 'digit_string',
    mailboxId: 'missing',
    threadViewerId: 'null',
  };
  const shaped = {
    ...withActor,
    actor: {
      ...actor,
      reason: 'actor_shape_unsupported',
      fields: { ...fields, rawId: 'private' },
    },
  };
  expect(safeSocialSessionDiagnostic(shaped)?.actor).toEqual({
    ...actor,
    reason: 'actor_shape_unsupported',
    fields,
  });
  for (const kind of ['private', null, 1, {}]) {
    expect(
      safeSocialSessionDiagnostic({
        ...shaped,
        actor: { ...shaped.actor, fields: { ...fields, viewerId: kind } },
      }),
    ).toBeUndefined();
  }

  expect(
    safeSocialSessionDiagnostic({
      ...withActor,
      actor: { ...actor, reason: 'private' },
    }),
  ).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({
      ...withActor,
      actor: { ...actor, anyViewerMatchesExpected: 'true' },
    }),
  ).toBeUndefined();
});

it('rebuilds the FB page observation from fixed enums and bounded counts only', async () => {
  const { safeSocialSessionDiagnostic } = await import('./social-session.js');
  const page = {
    lang: 'uk',
    readyState: 'complete',
    bodyRendered: true,
    bodyTextLength: '100_999',
    scanTruncated: false,
    visible: {
      busy: 0,
      progress: 0,
      dialog: 1,
      form: 1,
      password: 0,
      navigation: 1,
      banner: 1,
      main: 1,
    },
    names: {
      home: 2,
      menu: 1,
      account: 0,
      your_profile: 0,
      allow_all_cookies: 1,
      decline_optional_cookies: 1,
    },
    hrefs: { home: 2, profile: 0, messages: 1, me: 0, login: 0, other: 2 },
  };
  const raw = {
    version: 1,
    stage: 'auth',
    urlKind: 'home',
    navigationHttpStatus: 200,
    errorKind: 'timeout',
    semanticAuthImplemented: false,
    visible: {
      legacyAuth: 0,
      semanticAuth: 0,
      captcha: 0,
      checkpoint: 0,
      login: 0,
    },
    page,
  };
  expect(
    safeSocialSessionDiagnostic({
      ...raw,
      page: {
        ...page,
        text: 'private',
        title: 'secret',
        url: 'https://private',
        lang: 'uk',
        visible: { ...page.visible, rawText: 'secret' },
        names: { ...page.names, home: 999, private: 1 },
        hrefs: { ...page.hrefs, other: 999, url: 'private' },
      },
    }),
  ).toEqual(raw);
  for (const bad of [
    { ...page, lang: 'private' },
    { ...page, readyState: 'secret' },
    { ...page, bodyTextLength: 123 },
    { ...page, bodyRendered: 'true' },
    { ...page, scanTruncated: null },
    { ...page, names: null },
    ...[-1, 0.5, NaN, Infinity, '1'].map((n) => ({
      ...page,
      hrefs: { ...page.hrefs, home: n },
    })),
  ])
    expect(safeSocialSessionDiagnostic({ ...raw, page: bad })).toBeUndefined();
  expect(
    safeSocialSessionDiagnostic({ ...raw, semanticAuthImplemented: true }),
  ).toBeUndefined();
});

it('roundtrips full encrypted storage state including auxiliary Meta cookies and origins', () => {
  const state = {
    cookies: [
      ...normalizeSocialCookies(raw, 'instagram'),
      {
        ...normalizeSocialCookies(raw, 'instagram')[0]!,
        domain: '.messenger.com',
      },
    ],
    origins: [
      {
        origin: 'https://www.instagram.com',
        localStorage: [{ name: 'auth', value: 'private-rotated-token' }],
      },
      {
        origin: 'https://www.messenger.com',
        localStorage: [{ name: 'device', value: 'private-device' }],
      },
    ],
  };
  const value = account();
  const encrypted = encryptSocialStorageState(
    JSON.stringify(state),
    'instagram',
    secret,
  );
  expect(encrypted).not.toContain('private-rotated-token');
  const resolved = resolveSocialSession(
    {
      ...value,
      settings: { ...value.settings, storageStateEncrypted: encrypted },
    },
    secret,
    proxyUrls,
  );
  expect(resolved.storageState).toEqual(state);
  expect(() =>
    encryptSocialStorageState(
      JSON.stringify({ cookies: [], origins: [] }),
      'instagram',
      secret,
    ),
  ).toThrow();
});
it('prioritizes the encrypted own proxy without requiring a global proxy list', () => {
  const value = account();
  const ownProxyEncrypted = encryptSocialProxy(
    'http://own:private@own.example:8001',
    secret,
  );
  expect(ownProxyEncrypted).not.toContain('private');
  const session = resolveSocialSession(
    { ...value, settings: { ...value.settings, ownProxyEncrypted } },
    secret,
    '',
  );
  expect(session.proxy).toEqual({
    server: 'http://own.example:8001',
    username: 'own',
    password: 'private',
  });
  expect(
    socialAnonymousProxies(
      socialSessionProxies(
        'http://reserved.example:1,http://own.example:8001,http://public.example:2',
      ),
      0,
      [session.proxy],
    ),
  ).toEqual([{ server: 'http://public.example:2' }]);
});
it('generates a desktop fingerprint from the actual browser version and preserves stored device identity', () => {
  const device = generateSocialDevice('instagram', '142.0.0.0');
  expect(device).toMatchObject({
    userAgent: expect.stringContaining('Chrome/142.0.0.0'),
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    deviceScaleFactor: 1,
  });
  const value = account();
  expect(
    resolveSocialSession(
      { ...value, settings: { ...value.settings, device } },
      secret,
      proxyUrls,
    ).device,
  ).toEqual(device);
});

describe('account action restrictions', () => {
  it.each([
    'Try again later',
    'Action blocked',
    'We restrict certain activity',
    "You can't send messages",
    'Попробуйте позже',
    'Спробуйте пізніше',
    'Дію заблоковано',
    'Ми обмежуємо певні дії',
  ])('recognizes a fixed restriction in %s', (text) => {
    expect(detectSocialActionBlocked(text)).toBe(true);
    expect(new SocialSessionCheckError('action_blocked')).toMatchObject({
      code: 'session_invalid',
      reason: 'action_blocked',
    });
  });
  it('does not treat ordinary messages as restrictions', () => {
    expect(detectSocialActionBlocked('Your message was sent')).toBe(false);
  });
});
