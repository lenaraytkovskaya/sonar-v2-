import { apiUser, validId } from '@/lib/api-access';
import { productSchema, productStatusSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';

type Context = { params: Promise<{ id: string }> };
async function handle(
  request: Request,
  context: Context,
  mode: 'get' | 'edit' | 'status',
) {
  const user = await apiUser(request, mode !== 'get');
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.products.invalid }, { status: 400 });
  const parsed =
    mode === 'get'
      ? null
      : (mode === 'edit'
          ? productSchema
          : productSchema
              .pick({ status: true })
              .extend({ status: productStatusSchema })
        ).safeParse(await request.json().catch(() => null));
  if (parsed && !parsed.success)
    return Response.json({ error: uk.products.invalid }, { status: 400 });
  const db = await import('@sonar/db/products');
  const product =
    mode === 'get'
      ? await db.getProduct(id, user.id)
      : mode === 'edit'
        ? await db.saveProduct(productSchema.parse(parsed!.data), id, user.id)
        : await db.setProductStatus(id, parsed!.data!.status, user.id);
  return product
    ? Response.json(product)
    : Response.json({ error: uk.products.missing }, { status: 404 });
}
export const GET = (request: Request, context: Context) =>
  handle(request, context, 'get');
export const PUT = (request: Request, context: Context) =>
  handle(request, context, 'edit');
export const PATCH = (request: Request, context: Context) =>
  handle(request, context, 'status');
