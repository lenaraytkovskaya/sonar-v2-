import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { registryAction } = await import('@/lib/registry-actions');
  return Response.json(await registryAction(user.id), { status: 202 });
}
