import { beforeEach, expect, it, vi } from 'vitest';
const { query, logActivity } = vi.hoisted(() => ({
  query: vi.fn(),
  logActivity: vi.fn(),
}));
vi.mock('./tasks.js', () => ({
  logActivity,
  transaction: (fn: (client: unknown) => unknown) => fn({ query }),
}));
import {
  getProduct,
  listProducts,
  saveProduct,
  setProductStatus,
} from './products.js';
import { productSchema } from '../../core/src/products.js';
const row = {
  ...productSchema.parse({ name: 'Shared product' }),
  id: 'product',
  created_by: 'creator',
  created_at: new Date(0),
  updated_at: new Date(0),
};
beforeEach(() => vi.clearAllMocks());
it('denies every DB operation when the caller is not a team user', async () => {
  query.mockResolvedValue({ rows: [] });
  for (const operation of [
    () => listProducts('unknown'),
    () => getProduct('product', 'unknown'),
    () =>
      saveProduct(productSchema.parse({ name: 'Product' }), null, 'unknown'),
    () => setProductStatus('product', 'archived', 'unknown'),
  ]) {
    await expect(operation()).rejects.toThrow('Unauthorized');
  }
  expect(
    query.mock.calls.every(
      ([sql]) => sql === 'select id from users where id=$1',
    ),
  ).toBe(true);
  expect(logActivity).not.toHaveBeenCalled();
});
it('allows team members to read products created by another member', async () => {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'member' }] })
    .mockResolvedValueOnce({ rows: [row] });
  expect(await getProduct('product', 'member')).toMatchObject({
    created_by: 'creator',
    created_at: '1970-01-01T00:00:00.000Z',
  });
});
it.each(['archived', 'active'] as const)(
  'audits status transitions to %s without physical deletion',
  async (status) => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'member' }] })
      .mockResolvedValueOnce({
        rows: [{ status: status === 'active' ? 'archived' : 'active' }],
      })
      .mockResolvedValueOnce({ rows: [{ ...row, status }] });
    await setProductStatus('product', status, 'member');
    expect(logActivity).toHaveBeenCalledWith(
      `product.${status === 'active' ? 'restore' : 'archive'}`,
      'product',
      'product',
      'member',
      { status },
      expect.anything(),
    );
  },
);
it.each([null, 'product'])(
  'saves complete products and audits create/edit (%s)',
  async (id) => {
    query.mockResolvedValueOnce({ rows: [{ id: 'member' }] });
    if (id) query.mockResolvedValueOnce({ rows: [row] });
    query.mockResolvedValueOnce({ rows: [row] });
    await saveProduct(productSchema.parse({ name: row.name }), id, 'member');
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining(id ? 'update products' : 'insert into products'),
      expect.arrayContaining(['[]']),
    );
    expect(logActivity).toHaveBeenCalledWith(
      `product.${id ? 'update' : 'create'}`,
      'product',
      'product',
      'member',
      { status: 'active' },
      expect.anything(),
    );
  },
);
it('repeated archive requests are idempotent', async () => {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'member' }] })
    .mockResolvedValueOnce({ rows: [{ ...row, status: 'archived' }] });
  expect(await setProductStatus('product', 'archived', 'member')).toMatchObject(
    { status: 'archived' },
  );
  expect(query).toHaveBeenCalledTimes(2);
  expect(logActivity).not.toHaveBeenCalled();
});
