import { beforeEach, expect, it, vi } from 'vitest';

const { apiUser, query, connect, clientQuery, release, logActivity } =
  vi.hoisted(() => ({
    apiUser: vi.fn(),
    query: vi.fn(),
    connect: vi.fn(),
    clientQuery: vi.fn(),
    release: vi.fn(),
    logActivity: vi.fn(),
  }));
vi.mock('@/lib/api-access', () => ({ apiUser }));
vi.mock('@/i18n/uk', () => import('../../../i18n/uk'));
vi.mock(
  '@/lib/scanner-settings',
  () => import('../../../lib/scanner-settings'),
);
vi.mock('@/lib/social-settings', () => import('../../../lib/social-settings'));
vi.mock(
  '@sonar/core',
  () => import('../../../../../../packages/core/src/index.js'),
);
vi.mock('@sonar/db', () => ({ sonarPool: { query, connect } }));
vi.mock('@sonar/db/tasks', () => ({ logActivity }));
import { GET, POST } from './route.js';

const id = '83d7c52f-6aaa-47b1-aa49-c40d738cc44e';
const request = (value: unknown) =>
  new Request('http://localhost/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      about: '',
      budget: 50,
      cheap: '',
      strong: '',
      hoursExemptCompanyIds: value,
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  apiUser.mockResolvedValue({ id: 'owner' });
  query.mockResolvedValue({ rows: [] });
  clientQuery.mockResolvedValue({ rows: [] });
  connect.mockResolvedValue({ query: clientQuery, release });
});
it.each([null, {}, 'all', ['all'], [id, 42]])(
  'rejects malformed hours exemptions %j',
  async (value) => {
    expect((await POST(request(value))).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  },
);
it('saves normalized unique company UUIDs as JSONB and allows removing every exemption', async () => {
  for (const ids of [[id.toUpperCase(), id], []]) {
    expect((await POST(request(ids))).status).toBe(200);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('insert into settings(key,value)'),
      ['send.hours_exempt_company_ids', JSON.stringify(ids.length ? [id] : [])],
    );
  }
});
it('returns selected company names and IDs for the settings selector', async () => {
  query.mockResolvedValueOnce({
    rows: [{ key: 'send.hours_exempt_company_ids', value: [id] }],
  });
  query.mockResolvedValueOnce({ rows: [{ id, name: 'Test company' }] });
  const response = await GET(new Request('http://localhost/api/settings'));
  expect(await response.json()).toMatchObject({
    'send.hours_exempt_company_ids': [id],
    hoursExemptCompanies: [{ id, name: 'Test company' }],
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('select id,name from companies'),
    [[id]],
  );
});
it('rejects unauthenticated settings changes', async () => {
  apiUser.mockResolvedValue(null);
  expect((await POST(request([id]))).status).toBe(401);
  expect(connect).not.toHaveBeenCalled();
});
