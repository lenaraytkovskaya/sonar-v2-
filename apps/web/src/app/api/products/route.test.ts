import { beforeEach, expect, it, vi } from 'vitest';
const { apiUser, listProducts, getProduct, saveProduct, setProductStatus } =
  vi.hoisted(() => ({
    apiUser: vi.fn(),
    listProducts: vi.fn(),
    getProduct: vi.fn(),
    saveProduct: vi.fn(),
    setProductStatus: vi.fn(),
  }));
vi.mock('@/lib/api-access', () => ({
  apiUser,
  validId: (id: string) => /^[0-9a-f-]{36}$/.test(id),
}));
vi.mock('@/i18n/uk', () => import('../../../i18n/uk'));
vi.mock('@sonar/db/products', () => ({
  listProducts,
  getProduct,
  saveProduct,
  setProductStatus,
}));
import { GET, POST } from './route.js';
import { GET as detail, PUT, PATCH } from './[id]/route.js';
const context = {
  params: Promise.resolve({ id: '83d7c52f-6aaa-47b1-aa49-c40d738cc44e' }),
};
const request = (method: string, body?: unknown) =>
  new Request('http://localhost/api/products', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  apiUser.mockResolvedValue({ id: 'member' });
});
it('guards all routes before touching the DB, including rejected mutation origins', async () => {
  apiUser.mockResolvedValue(null);
  for (const [fn, method] of [
    [GET, 'GET'],
    [POST, 'POST'],
    [detail, 'GET'],
    [PUT, 'PUT'],
    [PATCH, 'PATCH'],
  ] as const)
    expect((await fn(request(method), context)).status).toBe(401);
  for (const fn of [listProducts, getProduct, saveProduct, setProductStatus])
    expect(fn).not.toHaveBeenCalled();
});
it('requires origin checks for mutations and validates status-only requests', async () => {
  expect(
    (
      await PATCH(
        request('PATCH', { status: 'archived', terms: 'extra' }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(apiUser).toHaveBeenLastCalledWith(expect.any(Request), true);
  expect(setProductStatus).not.toHaveBeenCalled();
  setProductStatus.mockResolvedValue({ id: 'product', status: 'archived' });
  expect(
    (await PATCH(request('PATCH', { status: 'archived' }), context)).status,
  ).toBe(200);
});
