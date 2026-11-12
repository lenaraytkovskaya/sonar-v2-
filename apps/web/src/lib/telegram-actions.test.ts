import { beforeEach, describe, expect, it, vi } from 'vitest';
const { session, begin, complete, update, logout } = vi.hoisted(() => ({
  session: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  update: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
vi.mock('@sonar/db/telegram', () => ({
  beginTelegramLogin: begin,
  completeTelegramLogin: complete,
  updateTelegramAccount: update,
  logoutTelegramAccount: logout,
}));
import { POST, PATCH, DELETE } from '../app/api/telegram-accounts/route';
import { uk } from '../i18n/uk';
const id = '00000000-0000-0000-0000-000000000001';
const request = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/telegram-accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Host: 'localhost',
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ user: { id: 'actor' } });
  begin.mockResolvedValue({
    id,
    step: 'code',
    sessionString: 'must-stay-private',
  });
  complete.mockResolvedValue({
    id,
    step: 'done',
    password: 'must-stay-private',
  });
});
describe('Telegram account routes', () => {
  it('requires a session for every mutation before accessing Telegram', async () => {
    session.mockResolvedValue({});
    for (const route of [POST, PATCH, DELETE])
      expect((await route(request({ id }))).status).toBe(401);
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutations with a valid session', async () => {
    for (const route of [POST, PATCH, DELETE])
      expect(
        (await route(request({ id }, 'https://other.example'))).status,
      ).toBe(401);
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
  it('rejects malformed account and login input before external work', async () => {
    for (const body of [
      null,
      { action: 'start', name: 'Test', phone: '+380671234567', dailyLimit: -1 },
      { action: 'complete', id, code: '123', password: 'secret' },
      { action: 'complete', id, code: 123 },
      { action: 'complete', id, password: '' },
      { action: 'complete', id, code: '123', password: {} },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect((await PATCH(request({ id, enabled: 'yes' }))).status).toBe(400);
    expect((await DELETE(request({ id: 'invalid' }))).status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
  it('starts login with the authenticated owner and returns only public progress', async () => {
    const body = { name: 'Test', phone: '+380671234567', dailyLimit: 10 };
    const response = await POST(request({ action: 'start', ...body }));
    expect(begin).toHaveBeenCalledWith(body, 'actor');
    expect(await response.json()).toEqual({ id, step: 'code' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('passes a manually entered password once and omits it from the response', async () => {
    const response = await POST(
      request({ action: 'complete', id, password: 'secret' }),
    );
    expect(complete).toHaveBeenCalledWith(
      id,
      { password: 'secret', code: undefined },
      'actor',
    );
    expect(await response.json()).toEqual({ id, step: 'done' });
  });
  it('does not expose unexpected provider errors or session data', async () => {
    complete.mockRejectedValue(
      new Error('sessionString=private password=secret'),
    );
    const response = await POST(
      request({ action: 'complete', id, password: 'secret' }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: uk.email.error });
  });
  it('binds account changes and disconnects to the authenticated owner', async () => {
    update.mockResolvedValue(true);
    logout.mockResolvedValue(true);
    expect((await PATCH(request({ id, enabled: false }))).status).toBe(200);
    expect(update).toHaveBeenCalledWith(id, { enabled: false }, 'actor');
    expect((await PATCH(request({ id, dailyLimit: 25 }))).status).toBe(200);
    expect(update).toHaveBeenCalledWith(id, { dailyLimit: 25 }, 'actor');
    expect((await PATCH(request({ id, dailyLimit: 0 }))).status).toBe(400);
    expect((await DELETE(request({ id }))).status).toBe(200);
    expect(logout).toHaveBeenCalledWith(id, 'actor');
  });
});
