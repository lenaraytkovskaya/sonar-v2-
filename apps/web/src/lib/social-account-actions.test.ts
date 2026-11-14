import { beforeEach, describe, expect, it, vi } from 'vitest';
const { session, list, save, update, check, sync } = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  check: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/lib/social-settings', () => import('./social-settings'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/social-accounts', () => ({
  listSocialAccounts: list,
  saveSocialAccount: save,
  updateSocialAccount: update,
  checkSocialSession: check,
  syncSocialInbox: sync,
  getSocialProxyCount: () => 2,
}));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
import { GET, POST, PATCH } from '../app/api/social-accounts/route';
import { uk } from '../i18n/uk';
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
