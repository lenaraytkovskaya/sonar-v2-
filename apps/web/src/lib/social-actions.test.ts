import { beforeEach, describe, expect, it, vi } from 'vitest';
const { session, enqueue, getSocial, query } = vi.hoisted(() => ({
  session: vi.fn(),
  enqueue: vi.fn(),
  getSocial: vi.fn(),
  query: vi.fn(),
}));
vi.mock('./auth', () => ({ getSession: session }));
vi.mock('@/lib/api-access', () => import('./api-access'));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/social', () => ({
  enqueueCompanySocial: enqueue,
  getCompanySocial: getSocial,
}));
import { GET, POST } from '../app/api/companies/[id]/social/route';
const id = '00000000-0000-0000-0000-000000000001';
const context = { params: Promise.resolve({ id }) };
const request = (method = 'POST', origin = 'http://localhost') =>
  new Request(`http://localhost/api/companies/${id}/social`, {
    method,
    headers: { Origin: origin, Host: 'localhost' },
  });
beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ user: { id: 'actor' } });
  query.mockResolvedValue({ rowCount: 1 });
  getSocial.mockResolvedValue({ profiles: [] });
});
describe('company social action', () => {
  it('queues a manual refresh with the authenticated actor and returns latest status', async () => {
    expect((await POST(request(), context)).status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(id, 'actor');
    expect(getSocial).toHaveBeenCalledWith(id);
  });
  it('requires authentication and same-origin mutations', async () => {
    session.mockResolvedValue({});
    expect((await GET(request('GET'), context)).status).toBe(401);
    expect((await POST(request(), context)).status).toBe(401);
    session.mockResolvedValue({ user: { id: 'actor' } });
    expect(
      (await POST(request('POST', 'https://other.example'), context)).status,
    ).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects invalid and missing companies without enqueueing', async () => {
    const invalid = { params: Promise.resolve({ id: 'bad' }) };
    expect((await GET(request('GET'), invalid)).status).toBe(400);
    expect((await POST(request(), invalid)).status).toBe(400);
    query.mockResolvedValue({ rowCount: 0 });
    expect((await POST(request(), context)).status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('reads public profiles and latest task status for authenticated users', async () => {
    const profiles = [
      {
        network: 'facebook',
        task: { status: 'skipped', reasonUk: 'Потрібна авторизація.' },
      },
    ];
    getSocial.mockResolvedValue({ profiles });
    expect(await (await GET(request('GET'), context)).json()).toEqual({
      profiles,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
