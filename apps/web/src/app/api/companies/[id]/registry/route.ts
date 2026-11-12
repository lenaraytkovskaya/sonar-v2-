import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const raw = await request.text();
  if (raw.trim()) {
    const data = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const { registryAction, validRegistryCandidate } =
      await import('@/lib/registry-actions');
    if (
      !data ||
      !['confirm', 'reject'].includes(data.action) ||
      !validRegistryCandidate(data.candidate)
    )
      return Response.json({ error: uk.ai.invalid }, { status: 400 });
    const result = await registryAction(user.id, {
      companyId: id,
      candidate: data.candidate,
      action: data.action,
    });
    return result
      ? Response.json(result, { status: data.action === 'confirm' ? 202 : 200 })
      : Response.json({ error: uk.registry.stale }, { status: 409 });
  }
  const { enqueueRegistryMatch } = await import('@sonar/db/tasks');
  return Response.json(await enqueueRegistryMatch(id, user.id), {
    status: 202,
  });
}
