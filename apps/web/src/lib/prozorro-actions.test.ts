import { beforeEach, describe, expect, it, vi } from 'vitest';
const { access, enqueue, query, activity } = vi.hoisted(() => ({
  access: vi.fn(),
  enqueue: vi.fn(),
  query: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('@/lib/api-access', () => ({ apiUser: access }));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/tasks', () => ({
  enqueueProzorroSync: enqueue,
  logActivity: activity,
}));
import { POST } from '../app/api/settings/prozorro/route';
const request = (action: unknown) =>
  new Request('http://localhost/api/settings/prozorro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ id: 'actor' });
  query.mockResolvedValue({ rows: [{ key: 'prozorro.enabled', value: true }] });
});
describe('Prozorro settings actions', () => {
  it('checks mutation authentication before touching settings or queue', async () => {
    access.mockResolvedValue(null);
    const input = request('start');
    expect((await POST(input)).status).toBe(401);
    expect(access).toHaveBeenCalledWith(input, true);
    expect(query).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects unsupported actions without mutations', async () => {
    expect((await POST(request('delete'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('starts through the atomic enqueue helper with the authenticated actor', async () => {
    const response = await POST(request('start'));
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith('actor');
    expect(await response.json()).toEqual({ 'prozorro.enabled': true });
  });
  it('persists a pause without queuing external work', async () => {
    expect((await POST(request('pause'))).status).toBe(202);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("value='false'::jsonb"),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith(
      'prozorro.pause',
      'settings',
      null,
      'actor',
    );
  });
});
