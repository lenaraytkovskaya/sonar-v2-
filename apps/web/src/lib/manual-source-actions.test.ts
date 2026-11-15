import { beforeEach, expect, it, vi } from 'vitest';
import { ManualSourceError } from '@sonar/core';
const { access, save, get, CodeError } = vi.hoisted(() => ({
  access: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
  CodeError: class extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  },
}));
vi.mock('@/lib/api-access', () => ({
  apiUser: access,
  validId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id),
}));
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
vi.mock('@sonar/db/companies', () => ({
  saveManualSource: save,
  getManualSource: get,
}));
vi.mock('@sonar/db/tasks', () => ({ ProzorroCodeError: CodeError }));
import { POST, GET } from '../app/api/companies/[id]/sources/route';
const id = '00000000-0000-4000-8000-000000000001';
const context = { params: Promise.resolve({ id }) };
const input = {
  requestId: id,
  source: 'website',
  value: 'example.com',
  expected: null,
};
const request = (body: unknown = input) =>
  new Request(`http://localhost/api/companies/${id}/sources`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ id: 'actor' });
  save.mockResolvedValue({ tasks: [{ id, status: 'queued' }] });
  get.mockResolvedValue(null);
});
it('checks mutation authentication and origin before reading or saving sources', async () => {
  access.mockResolvedValue(null);
  const req = request();
  expect((await POST(req, context)).status).toBe(401);
  expect(access).toHaveBeenCalledWith(req, true);
  expect(save).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...input, source: 'history' },
  { ...input, source: 'analysis' },
  { ...input, companyId: id },
  { ...input, requestId: 'bad' },
])('rejects invalid contracts %j', async (body) => {
  expect((await POST(request(body), context)).status).toBe(400);
  expect(save).not.toHaveBeenCalled();
});
it('binds to the route company and session actor', async () => {
  expect((await POST(request(), context)).status).toBe(202);
  expect(save).toHaveBeenCalledWith(id, input, 'actor');
});
it.each([
  ['staleSource', 409],
  ['sourceBusy', 409],
  ['companyNotFound', 404],
  ['invalidGoogleMaps', 400],
] as const)('returns useful %s error', async (code, status) => {
  save.mockRejectedValueOnce(new ManualSourceError(code));
  const response = await POST(request(), context);
  expect(response.status).toBe(status);
  expect((await response.json()).error).toMatch(/[А-ЯІЄЇ]/);
});
it('preserves PR95 conflicting code guard', async () => {
  save.mockRejectedValueOnce(new CodeError('conflictingCode'));
  expect((await POST(request(), context)).status).toBe(409);
});
it('returns a useful queue failure without claiming the source was saved', async () => {
  save.mockRejectedValueOnce(Error('queue unavailable'));
  expect((await POST(request(), context)).status).toBe(503);
});
it('validates and authenticates source status reads', async () => {
  const req = new Request(
    `http://localhost/api/companies/${id}/sources?source=website&requestId=${id}`,
  );
  expect((await GET(req, context)).status).toBe(200);
  expect(get).toHaveBeenCalledWith(id, 'website', id);
  access.mockResolvedValueOnce(null);
  expect((await GET(req, context)).status).toBe(401);
  expect(
    (await GET(new Request('http://localhost/?source=history'), context))
      .status,
  ).toBe(400);
});
