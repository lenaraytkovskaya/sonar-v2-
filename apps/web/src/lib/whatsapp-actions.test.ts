import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  session,
  list,
  connect,
  refresh,
  restart,
  repair,
  update,
  logout,
  diagnose,
} = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  connect: vi.fn(),
  refresh: vi.fn(),
  restart: vi.fn(),
  repair: vi.fn(),
  update: vi.fn(),
  logout: vi.fn(),
  diagnose: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/email', () => ({
  EmailValidationError: class extends Error {
    reasonUk = 'Некоректні дані.';
  },
}));
vi.mock('@sonar/db/whatsapp', () => ({
  listWhatsAppAccounts: list,
  connectWhatsAppAccount: connect,
  refreshWhatsAppAccount: refresh,
  restartWhatsAppAccount: restart,
  repairWhatsAppWebhook: repair,
  updateWhatsAppAccount: update,
  logoutWhatsAppAccount: logout,
  diagnoseWhatsAppWebhook: diagnose,
}));
import { GET, POST, PATCH, DELETE } from '../app/api/whatsapp-accounts/route';
import { uk } from '../i18n/uk';
const id = '00000000-0000-0000-0000-000000000001';
const request = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/whatsapp-accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Host: 'localhost',
    },
    body: JSON.stringify(body),
  });
const read = () =>
  new Request(`http://localhost/api/whatsapp-accounts?id=${id}`);
const account = {
  id,
  name: 'Team',
  address: '+••••4567',
  dailyLimit: 10,
  sentToday: 0,
  enabled: false,
  desiredEnabled: true,
  providerName: 'WhatsApp Team',
  nextSendAt: null,
  ownerName: 'Owner',
  status: 'qr',
  reasonUk: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ user: { id: 'actor' } });
  list.mockResolvedValue([{ ...account, apiKey: 'private', qr: 'never-list' }]);
  connect.mockResolvedValue({
    id,
    status: 'qr',
    qr: 'data:image/png;base64,YWJj',
    apiKey: 'private',
  });
  refresh.mockResolvedValue({
    id,
    status: 'active',
    qr: 'data:image/png;base64,YWJj',
  });
  restart.mockResolvedValue({ id, status: 'starting' });
  repair.mockResolvedValue({ id, status: 'starting', apiKey: 'private' });
  update.mockResolvedValue(true);
  logout.mockResolvedValue(true);
});
describe('WhatsApp account API', () => {
  it('requires authentication for reads and all mutations', async () => {
    session.mockResolvedValue({});
    expect((await GET(read())).status).toBe(401);
    expect((await POST(request({ action: 'repair-webhook', id }))).status).toBe(
      401,
    );
    expect(repair).not.toHaveBeenCalled();
    for (const route of [POST, PATCH, DELETE])
      expect((await route(request({ id }))).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('protects repair by origin and id, binds it to actor and redacts its result/errors', async () => {
    expect(
      (
        await POST(
          request({ action: 'repair-webhook', id }, 'https://other.example'),
        )
      ).status,
    ).toBe(401);
    expect(
      (await POST(request({ action: 'repair-webhook', id: 'bad' }))).status,
    ).toBe(400);
    expect(repair).not.toHaveBeenCalled();
    const response = await POST(request({ action: 'repair-webhook', id }));
    expect(repair).toHaveBeenCalledWith(id, 'actor');
    expect((await response.json()).progress).toEqual({
      id,
      status: 'starting',
      reasonUk: null,
    });
    repair.mockRejectedValueOnce(Error('private-test-key config'));
    const failed = await POST(request({ action: 'repair-webhook', id }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: uk.email.error });
  });
  it('rejects cross-origin mutations before external calls', async () => {
    for (const route of [POST, PATCH, DELETE])
      expect(
        (await route(request({ id }, 'https://other.example'))).status,
      ).toBe(401);
    expect(connect).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(
      (await POST(request({ action: 'refresh', id }, 'https://other.example')))
        .status,
    ).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('validates account identifiers and settings', async () => {
    for (const body of [
      null,
      { action: 'start', name: '', dailyLimit: 10 },
      { action: 'start', name: 'Test', dailyLimit: 0 },
      { action: 'restart', id: 'bad' },
      { action: 'other', id },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect((await PATCH(request({ id, enabled: 'yes' }))).status).toBe(400);
    expect((await PATCH(request({ id, dailyLimit: 1.5 }))).status).toBe(400);
    expect((await PATCH(request({ id }))).status).toBe(400);
    expect((await DELETE(request({ id: 'bad' }))).status).toBe(400);
    expect((await POST(request({ action: 'refresh', id: 'bad' }))).status).toBe(
      400,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('starts the single server-side session and only returns public fields without caching QR', async () => {
    const response = await POST(
      request({ action: 'start', name: 'Team', dailyLimit: 10 }),
    );
    expect(connect).toHaveBeenCalledWith(
      { name: 'Team', dailyLimit: 10 },
      'actor',
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      accounts: [account],
      progress: {
        id,
        status: 'qr',
        qr: 'data:image/png;base64,YWJj',
        reasonUk: null,
      },
    });
  });
  it('lists accounts without refreshing provider state on GET', async () => {
    const response = await GET(read());
    expect(await response.json()).toEqual({ accounts: [account] });
    expect(refresh).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
  });
  it('requires authentication and a valid explicit diagnostic action', async () => {
    const readDiagnostic = (query: string) =>
      new Request(`http://localhost/api/whatsapp-accounts?${query}`);
    session.mockResolvedValueOnce({});
    expect(
      (await GET(readDiagnostic(`action=diagnose-webhook&id=${id}`))).status,
    ).toBe(401);
    for (const query of [
      'action=diagnose-webhook',
      'action=diagnose-webhook&id=bad',
      `action=other&id=${id}`,
    ])
      expect((await GET(readDiagnostic(query))).status).toBe(400);
    expect(diagnose).not.toHaveBeenCalled();
  });
  it('returns diagnostic JSON through GET with the authenticated owner and no account mutations', async () => {
    const diagnostic = { scope: 'session_config_only', apiKeyMatches: false };
    diagnose.mockResolvedValueOnce(diagnostic);
    const response = await GET(
      new Request(
        `http://localhost/api/whatsapp-accounts?action=diagnose-webhook&id=${id}`,
      ),
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ diagnostic });
    expect(diagnose).toHaveBeenCalledWith(id, 'actor');
    for (const operation of [list, connect, refresh, restart, update, logout])
      expect(operation).not.toHaveBeenCalled();
    diagnose.mockRejectedValueOnce(Error('private-key and config'));
    const failed = await GET(
      new Request(
        `http://localhost/api/whatsapp-accounts?action=diagnose-webhook&id=${id}`,
      ),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: uk.email.error });
  });
  it('polls status through a protected mutation and clears QR once connected', async () => {
    const response = await POST(request({ action: 'refresh', id }));
    expect(refresh).toHaveBeenCalledWith(id, 'actor');
    expect((await response.json()).progress).toEqual({
      id,
      status: 'active',
      reasonUk: null,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('never renders a provider-controlled remote QR URL', async () => {
    connect.mockResolvedValue({
      id,
      status: 'qr',
      qr: 'https://provider.example/secret',
    });
    expect(
      (
        await (
          await POST(request({ action: 'start', name: 'Team', dailyLimit: 10 }))
        ).json()
      ).progress.qr,
    ).toBeUndefined();
  });
  it('binds restart, settings and logout to the signed-in actor', async () => {
    expect((await POST(request({ action: 'restart', id }))).status).toBe(200);
    expect(restart).toHaveBeenCalledWith(id, 'actor');
    expect(
      (await PATCH(request({ id, enabled: false, dailyLimit: 25 }))).status,
    ).toBe(200);
    expect(update).toHaveBeenCalledWith(
      id,
      { enabled: false, dailyLimit: 25 },
      'actor',
    );
    expect((await DELETE(request({ id }))).status).toBe(200);
    expect(logout).toHaveBeenCalledWith(id, 'actor');
  });
  it('keeps unexpected provider errors private', async () => {
    refresh.mockRejectedValue(
      Error('Authorization private-key provider session'),
    );
    const response = await POST(request({ action: 'refresh', id }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: uk.email.error });
  });
});
