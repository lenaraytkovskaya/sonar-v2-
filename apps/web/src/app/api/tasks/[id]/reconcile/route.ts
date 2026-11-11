import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  if (!validId(id) || typeof body?.charged !== 'boolean')
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { reconcileBilling } = await import('@sonar/db/budget');
  const reconciled = await reconcileBilling(id, body.charged, user.id);
  return Response.json({ reconciled }, { status: reconciled ? 200 : 409 });
}
