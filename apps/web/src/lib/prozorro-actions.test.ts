import { beforeEach, describe, expect, it, vi } from 'vitest';
const { access, enqueue, query, activity, company, campaign, CodeError } =
  vi.hoisted(() => ({
    CodeError: class extends Error {
      constructor(
        public reason: 'invalidCode' | 'conflictingCode' | 'companyBusy',
      ) {
        super(reason);
      }
    },
    access: vi.fn(),
    enqueue: vi.fn(),
    query: vi.fn(),
    activity: vi.fn(),
    company: vi.fn(),
    campaign: vi.fn(),
  }));
vi.mock('@/lib/api-access', () => ({
  apiUser: access,
  validId: (id: unknown) =>
    typeof id === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id),
}));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/tasks', () => ({
  enqueueProzorroSync: enqueue,
  enqueueProzorroCompany: company,
  ProzorroCodeError: CodeError,
  enqueueCampaignProzorro: campaign,
  logActivity: activity,
}));
import { POST } from '../app/api/settings/prozorro/route';
import { POST as companyPost } from '../app/api/companies/[id]/prozorro/route';
import { POST as campaignPost } from '../app/api/campaigns/[id]/prozorro/route';
const request = (action: unknown) =>
  new Request('http://localhost/api/settings/prozorro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ id: 'actor' });
  query.mockResolvedValue({
    rows: [{ key: 'prozorro.full_sync.enabled', value: true }],
  });
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
    expect(await response.json()).toEqual({
      'prozorro.full_sync.enabled': true,
    });
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

describe('company and campaign Prozorro actions', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  it('authenticates mutations and rejects invalid ids before queueing', async () => {
    for (const action of [companyPost, campaignPost]) {
      access.mockResolvedValue(null);
      expect((await action(request('start'), context(id))).status).toBe(401);
      access.mockResolvedValue({ id: 'actor' });
      expect((await action(request('start'), context('invalid'))).status).toBe(
        400,
      );
    }
    expect(query).not.toHaveBeenCalled();
    expect(company).not.toHaveBeenCalled();
    expect(campaign).not.toHaveBeenCalled();
  });
  it('queues only the requested company/campaign with the authenticated actor, and handles missing subjects', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    company.mockResolvedValue({ id: 'task', created: true });
    campaign.mockResolvedValue(3);
    expect((await companyPost(request('start'), context(id))).status).toBe(202);
    expect(company).toHaveBeenCalledWith(id, 'actor');
    expect(
      await (await campaignPost(request('start'), context(id))).json(),
    ).toEqual({ count: 3 });
    expect(campaign).toHaveBeenCalledWith(id, 'actor');
    query.mockResolvedValue({ rowCount: 0 });
    expect((await companyPost(request('start'), context(id))).status).toBe(404);
  });
  it('enables company lookup without starting a full feed', async () => {
    expect((await POST(request('enable'))).status).toBe(202);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("where key='prozorro.enabled'"),
      ['true'],
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('explicit company code entry', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  const context = { params: Promise.resolve({ id }) };
  const input = (body?: string) =>
    new Request('http://localhost/api/companies/' + id + '/prozorro', {
      method: 'POST',
      body,
    });
  it('passes a known code only for the explicit action; empty requests retain normal lookup', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    company.mockResolvedValue({ id: 'task', created: true });
    expect(
      (await companyPost(input('{"code":"41165490"}'), context)).status,
    ).toBe(202);
    expect(company).toHaveBeenLastCalledWith(id, 'actor', undefined, {
      manualCode: '41165490',
    });
    expect((await companyPost(input(), context)).status).toBe(202);
    expect(company).toHaveBeenLastCalledWith(id, 'actor');
  });
  it.each([
    '{"code":"1234****"}',
    '{"code":41165490}',
    '{"code":null}',
    '{"code":""}',
    '{',
    'null',
    '[]',
  ])(
    'rejects invalid code or malformed body %s before touching data',
    async (body) => {
      expect((await companyPost(input(body), context)).status).toBe(400);
      expect(company).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('preserves mutation authentication for the manual code action', async () => {
    access.mockResolvedValue(null);
    const request = input('{"code":"41165490"}');
    expect((await companyPost(request, context)).status).toBe(401);
    expect(access).toHaveBeenCalledWith(request, true);
    expect(company).not.toHaveBeenCalled();
  });
  it.each(['conflictingCode', 'companyBusy'] as const)(
    'returns a readable conflict for %s',
    async (reason) => {
      query.mockResolvedValue({ rowCount: 1 });
      company.mockRejectedValue(new CodeError(reason));
      const response = await companyPost(input('{"code":"41165490"}'), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    },
  );
});
