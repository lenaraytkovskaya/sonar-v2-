import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  session,
  list,
  listNotices,
  save,
  update,
  check,
  sync,
  credentials,
  login,
  code,
  remove,
  createWithCredentials,
} = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  listNotices: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  check: vi.fn(),
  sync: vi.fn(),
  credentials: vi.fn(),
  login: vi.fn(),
  code: vi.fn(),
  remove: vi.fn(),
  createWithCredentials: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/lib/social-settings', () => import('./social-settings'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/social-accounts', () => ({
  listSocialAccounts: list,
  listSocialSessionNotices: listNotices,
  saveSocialAccount: save,
  updateSocialAccount: update,
  checkSocialSession: check,
  syncSocialInbox: sync,
  saveSocialCredentials: credentials,
  queueSocialCredentialLogin: login,
  submitSocialLoginCode: code,
  removeSocialAccount: remove,
  createSocialAccountWithCredentials: createWithCredentials,
  getSocialProxyCount: () => 2,
}));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
import { GET, POST, PATCH, DELETE } from '../app/api/social-accounts/route';
import { uk } from '../i18n/uk';
import { GET as notices } from '../app/api/social-accounts/notices/route';
const id = '00000000-0000-0000-0000-000000000001';
const request = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/social-accounts', {
    method: 'POST',
    headers: { Origin: origin, Host: 'localhost' },
    body: JSON.stringify(body),
  });
const input = {
  name: 'Test',
  network: 'instagram',
  dailyLimit: 20,
  proxyIndex: 0,
  cookiesJson: '[{"name":"sessionid","value":"secret"}]',
};
beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue(undefined);
  remove.mockResolvedValue(true);
  createWithCredentials.mockResolvedValue({
    id: 'new-account',
    loginTaskId: 'new-login-task',
  });
  credentials.mockResolvedValue({ id: 'login-task', created: true });
  session.mockResolvedValue({ user: { id: 'actor' } });
  list.mockResolvedValue([
    {
      id,
      name: 'Test',
      network: 'instagram',
      dailyLimit: 20,
      sentToday: 0,
      enabled: false,
      status: 'paused',
      sessionStatus: 'pending',
      reasonUk: null,
      checkedAt: null,
      nextSendAt: null,
      proxyIndex: 0,
      ownerName: 'User',
      cookies: 'private',
      cookiesJson: 'private',
      cookiesEncrypted: 'private',
      credentialsEncrypted: 'private',
      proxyUrl: 'https://user:password@proxy',
    },
  ]);
});
describe('social account API', () => {
  it('requires authentication and same-origin mutations', async () => {
    session.mockResolvedValue({});
    expect(
      (await GET(new Request('http://localhost/api/social-accounts'))).status,
    ).toBe(401);
    for (const action of [POST, PATCH])
      expect((await action(request(input))).status).toBe(401);
    session.mockResolvedValue({ user: { id: 'actor' } });
    expect((await POST(request(input, 'https://other.example'))).status).toBe(
      401,
    );
    expect(save).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it('saves secret input once with the authenticated actor and returns only an explicit public projection', async () => {
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(input, 'actor');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('private');
    expect(body).not.toContain('password');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('cookies');
  });
  it('rejects unsupported networks, out-of-range proxies and invalid limits before saving', async () => {
    for (const patch of [
      { network: 'tiktok' },
      { proxyIndex: 2 },
      { proxyIndex: -1 },
      { dailyLimit: 0 },
      { dailyLimit: 2.5 },
      { cookiesJson: {} },
      { id: 'bad' },
    ])
      expect((await POST(request({ ...input, ...patch }))).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
  it('queues session checks and toggles enabled state without returning session cookies', async () => {
    expect((await POST(request({ action: 'check', id }))).status).toBe(202);
    expect(check).toHaveBeenCalledWith(id, 'actor');
    expect((await PATCH(request({ id, enabled: true }))).status).toBe(200);
    expect(update).toHaveBeenCalledWith(id, { enabled: true }, 'actor');
    expect((await PATCH(request({ id, enabled: 'yes' }))).status).toBe(400);
  });
  it('redacts unexpected error details', async () => {
    save.mockRejectedValue(new Error('cookies=secret proxy=password'));
    const response = await POST(request(input));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: uk.email.error });
  });
});

it('creates an account with credentials through the shared credential flow and returns no secret', async () => {
  const fields = {
    action: 'createWithCredentials',
    name: 'Login account',
    network: 'facebook',
    dailyLimit: 20,
    proxyIndex: 0,
    login: 'private-login',
    password: 'private-password',
    totpSecret: 'JBSW Y3DP-EHPK3PXP',
  };
  const response = await POST(request(fields));
  expect(response.status).toBe(202);
  expect(createWithCredentials).toHaveBeenCalledWith(
    {
      name: fields.name,
      network: fields.network,
      dailyLimit: fields.dailyLimit,
      proxyIndex: fields.proxyIndex,
      login: fields.login,
      password: fields.password,
      totpSecret: 'JBSWY3DPEHPK3PXP',
    },
    'actor',
  );
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain('private-login');
  expect(body).not.toContain('private-password');
  expect(body).not.toContain('JBSW');
});

it('removes a social account only with the exact remove action and authenticated actor', async () => {
  const response = await DELETE(
    new Request('http://localhost/api/social-accounts', {
      method: 'DELETE',
      headers: { Origin: 'http://localhost', Host: 'localhost' },
      body: JSON.stringify({ action: 'remove', id }),
    }),
  );
  expect(response.status).toBe(200);
  expect(remove).toHaveBeenCalledWith(id, 'actor');
  expect(
    (
      await DELETE(
        new Request('http://localhost/api/social-accounts', {
          method: 'DELETE',
          headers: { Origin: 'http://localhost', Host: 'localhost' },
          body: JSON.stringify({ action: 'remove', id, extra: true }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(remove).toHaveBeenCalledOnce();
});

it('queues only the server-authorized account action and returns its existing task receipt', async () => {
  sync.mockResolvedValue({ id: 'manual-task', created: false });
  const response = await POST(request({ action: 'syncInbox', id }));
  expect(response.status).toBe(202);
  expect(sync).toHaveBeenCalledWith(id, 'actor');
  expect((await response.json()).inboxSync).toEqual({
    id: 'manual-task',
    created: false,
  });
  expect(save).not.toHaveBeenCalled();
});
it('rejects unauthenticated, cross-origin and client-supplied manual privilege fields before enqueue', async () => {
  session.mockResolvedValue({});
  expect((await POST(request({ action: 'syncInbox', id }))).status).toBe(401);
  session.mockResolvedValue({ user: { id: 'actor' } });
  expect(
    (await POST(request({ action: 'syncInbox', id }, 'https://other.example')))
      .status,
  ).toBe(401);
  for (const extra of [
    { mode: 'manual' },
    { requestedBy: 'other' },
    { accountId: id },
    { network: 'instagram' },
  ])
    expect(
      (await POST(request({ action: 'syncInbox', id, ...extra }))).status,
    ).toBe(400);
  expect((await POST(request({ action: 'syncInbox', id: 'bad' }))).status).toBe(
    400,
  );
  expect(sync).not.toHaveBeenCalled();
});

it('returns an account authorization failure before listing success or accepting a task', async () => {
  const { EmailValidationError } = await import('@sonar/db/email');
  sync.mockRejectedValueOnce(new EmailValidationError('Акаунт недоступний.'));
  const response = await POST(request({ action: 'syncInbox', id }));
  expect(response.status).toBe(400);
  expect(sync).toHaveBeenCalledWith(id, 'actor');
  expect(list).not.toHaveBeenCalled();
});

it('accepts a private proxy and storageState without exposing either credential', async () => {
  const fields = {
    name: 'Test',
    network: 'instagram',
    dailyLimit: 20,
    ownProxy: 'http://user:secret@proxy.example:8080',
    storageStateJson: '{"cookies":[],"origins":[]}',
    keepaliveEnabled: true,
  };
  const response = await POST(request(fields));
  expect(response.status).toBe(200);
  expect(save).toHaveBeenCalledWith(fields, 'actor');
  const result = JSON.stringify(await response.json());
  expect(result).not.toContain('secret');
  expect(result).not.toContain('storageState');
});
it('allows changing the proxy without resubmitting cookies and validates secret input types', async () => {
  const fields = {
    id,
    name: 'Test',
    network: 'instagram',
    dailyLimit: 20,
    proxyIndex: 1,
    ownProxy: null,
  };
  expect((await POST(request(fields))).status).toBe(200);
  expect(save).toHaveBeenCalledWith(fields, 'actor');
  for (const patch of [
    { ownProxy: {} },
    { storageStateJson: {} },
    { keepaliveEnabled: 'yes' },
  ])
    expect((await POST(request({ ...fields, ...patch }))).status).toBe(400);
});
it('requires authentication and returns lightweight unresolved event metadata for polling', async () => {
  const req = new Request('http://localhost/api/social-accounts/notices');
  session.mockResolvedValueOnce({});
  expect((await notices(req)).status).toBe(401);
  expect(listNotices).not.toHaveBeenCalled();
  const unresolved = [
    {
      id,
      name: 'Test',
      network: 'instagram',
      eventId: 'event-1',
      reasonUk: 'Потрібен вхід',
    },
  ];
  listNotices.mockResolvedValue(
    unresolved.map((notice) => ({
      ...notice,
      ownProxy: 'secret',
      storageState: 'private',
    })),
  );
  const response = await notices(req);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    userId: 'actor',
    notices: unresolved,
  });
  expect(listNotices).toHaveBeenCalledWith('actor');
  expect(list).not.toHaveBeenCalled();
});

describe('social credential login API', () => {
  const fields = {
    action: 'credentials',
    id,
    login: 'account',
    password: 'private-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  };
  it('saves and queues credentials, starts saved login, and accepts an email/SMS code with the authenticated actor', async () => {
    expect((await POST(request(fields))).status).toBe(202);
    expect(credentials).toHaveBeenCalledWith(
      id,
      {
        login: fields.login,
        password: fields.password,
        totpSecret: fields.totpSecret,
      },
      'actor',
    );
    expect((await POST(request({ action: 'login', id }))).status).toBe(202);
    expect(login).toHaveBeenCalledWith(id, 'actor');
    expect(
      (await POST(request({ action: 'loginCode', id, code: '012345' }))).status,
    ).toBe(202);
    expect(code).toHaveBeenCalledWith(id, '012345', 'actor');
    expect(save).not.toHaveBeenCalled();
  });
  it('returns saved-only status without exposing secrets when login was not queued', async () => {
    credentials.mockResolvedValueOnce({ id: null, created: false });
    const response = await POST(request(fields));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toMatch(
      /private|password|JBSWY/,
    );
    expect(login).not.toHaveBeenCalled();
  });
  it('normalizes provider TOTP formatting and supports explicit deletion without returning secrets', async () => {
    expect(
      (await POST(request({ ...fields, totpSecret: 'jbsw-y3dp ehpk3pxp====' })))
        .status,
    ).toBe(202);
    expect(credentials).toHaveBeenLastCalledWith(
      id,
      {
        login: fields.login,
        password: fields.password,
        totpSecret: fields.totpSecret,
      },
      'actor',
    );
    expect((await POST(request({ ...fields, totpSecret: null }))).status).toBe(
      202,
    );
    expect(credentials).toHaveBeenLastCalledWith(
      id,
      { login: fields.login, password: fields.password, totpSecret: null },
      'actor',
    );
  });
  it('requires authentication and same-origin for every credential action', async () => {
    for (const body of [
      fields,
      { action: 'login', id },
      { action: 'loginCode', id, code: '123456' },
    ]) {
      session.mockResolvedValueOnce({});
      expect((await POST(request(body))).status).toBe(401);
      expect((await POST(request(body, 'https://other.example'))).status).toBe(
        401,
      );
    }
    expect(credentials).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
  });
  it('rejects malformed secrets, codes, unsupported actions, and privilege fields before DB calls', async () => {
    for (const body of [
      { ...fields, id: 'bad' },
      { ...fields, password: '' },
      { ...fields, login: 1 },
      { ...fields, totpSecret: 'not-base32!' },
      { ...fields, requestedBy: 'other' },
      { action: 'login', id, password: 'extra' },
      { action: 'loginCode', id, code: 123456 },
      { action: 'loginCode', id, code: '123' },
      { action: 'loginCode', id, code: '123456', challengeKind: 'sms' },
      { ...input, action: 'unknown' },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect(credentials).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('projects only credential booleans and challenge metadata and redacts all credential errors', async () => {
    list.mockResolvedValue([
      {
        id,
        hasCredentials: true,
        hasTotpSecret: true,
        loginBlocked: false,
        loginChallengeKind: 'sms',
        loginChallengeExpiresAt: '2030-01-01T00:00:00Z',
        login: 'private-login',
        password: 'private-password',
        totpSecret: fields.totpSecret,
        code: '123456',
        loginCodeEncrypted: 'private-code',
        challenge: { selector: 'private-selector' },
      },
    ]);
    const response = await POST(request(fields));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = await response.json();
    expect(result.accounts[0]).toMatchObject({
      hasCredentials: true,
      hasTotpSecret: true,
      loginBlocked: false,
      loginChallengeKind: 'sms',
      loginChallengeExpiresAt: '2030-01-01T00:00:00Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/private|123456|JBSWY/);
    const { EmailValidationError } = await import('@sonar/db/email');
    const failure = new EmailValidationError('private');
    failure.reasonUk = 'private-password';
    code.mockRejectedValueOnce(failure);
    const failed = await POST(
      request({ action: 'loginCode', id, code: '123456' }),
    );
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: uk.email.error });
    credentials.mockRejectedValueOnce(new Error('private-password'));
    expect(await (await POST(request(fields))).json()).toEqual({
      error: uk.email.error,
    });
  });
});
