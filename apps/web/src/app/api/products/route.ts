import { apiUser } from '@/lib/api-access';
import { productSchema, productStatusSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const status = new URL(request.url).searchParams.get('status');
  const parsed = productStatusSchema.optional().safeParse(status ?? undefined);
  if (!parsed.success)
    return Response.json({ error: uk.products.invalid }, { status: 400 });
  const { listProducts } = await import('@sonar/db/products');
  return Response.json({ products: await listProducts(user.id, parsed.data) });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const parsed = productSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json({ error: uk.products.invalid }, { status: 400 });
  const { saveProduct } = await import('@sonar/db/products');
  return Response.json(await saveProduct(parsed.data, null, user.id), {
    status: 201,
  });
}
