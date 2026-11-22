import {
  productSchema,
  productStatusSchema,
  type ProductInput,
  type ProductDto,
} from '@sonar/core';
import type { PoolClient } from 'pg';
import { logActivity, transaction } from './tasks.js';

// Products, like campaigns, are shared by the authenticated team; users have no roles.
function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>) {
  return transaction(async (client) => {
    if (
      !(await client.query('select id from users where id=$1', [userId]))
        .rows[0]
    )
      throw new Error('Unauthorized');
    return fn(client);
  });
}
type ProductRow = Omit<ProductDto, 'created_at' | 'updated_at'> & {
  created_at: Date;
  updated_at: Date;
};
const dto = (row: ProductRow): ProductDto => ({
  ...row,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});
export function listProducts(userId: string, status?: ProductInput['status']) {
  if (status !== undefined) productStatusSchema.parse(status);
  return withUser(userId, async (client) =>
    (
      await client.query<ProductRow>(
        'select * from products where ($1::text is null or status=$1) order by created_at desc,id',
        [status ?? null],
      )
    ).rows.map(dto),
  );
}
export function getProduct(id: string, userId: string) {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<ProductRow>(
      'select * from products where id=$1',
      [id],
    );
    return rows[0] ? dto(rows[0]) : null;
  });
}
function writeProduct(
  data: ProductInput | Pick<ProductInput, 'status'>,
  id: string | null,
  userId: string,
) {
  return withUser(userId, async (client) => {
    const previous = id
      ? (
          await client.query('select * from products where id=$1 for update', [
            id,
          ])
        ).rows[0]
      : null;
    if (id && !previous) return null;
    const fields = 'name' in data;
    if (!fields && previous.status === data.status) return dto(previous);
    const values = fields
      ? [
          data.name,
          data.tagline,
          data.description,
          data.audience,
          data.benefits,
          data.terms,
          JSON.stringify(data.links),
          JSON.stringify(data.photos),
          JSON.stringify(data.videos),
          data.status,
        ]
      : [data.status];
    const { rows } = await client.query<ProductRow>(
      !fields
        ? 'update products set status=$1,updated_at=now() where id=$2 returning *'
        : id
          ? 'update products set name=$1,tagline=$2,description=$3,audience=$4,benefits=$5,terms=$6,links=$7,photos=$8,videos=$9,status=$10,updated_at=now() where id=$11 returning *'
          : 'insert into products(name,tagline,description,audience,benefits,terms,links,photos,videos,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',
      [...values, id ?? userId],
    );
    const product = dto(rows[0]!);
    const action = !id
      ? 'create'
      : previous.status === data.status
        ? 'update'
        : data.status === 'archived'
          ? 'archive'
          : 'restore';
    if (fields || previous.status !== data.status)
      await logActivity(
        `product.${action}`,
        'product',
        product.id,
        userId,
        { status: data.status },
        client,
      );
    return product;
  });
}
export function saveProduct(
  input: ProductInput,
  id: string | null,
  userId: string,
) {
  return writeProduct(productSchema.parse(input), id, userId);
}
export function setProductStatus(
  id: string,
  status: ProductInput['status'],
  userId: string,
) {
  return writeProduct(
    { status: productStatusSchema.parse(status) },
    id,
    userId,
  );
}
