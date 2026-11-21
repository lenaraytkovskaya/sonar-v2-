import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { campaignRunState } = await import('@sonar/db/campaign-run');
  const state = await campaignRunState(id);
  if (!state) return Response.json({ error: uk.ai.invalid }, { status: 404 });
  return Response.json(state);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  if (!validId(id) || !['pause', 'resume'].includes(body?.action))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { pauseCampaign, resumeCampaign } =
    await import('@sonar/db/campaign-run');
  const result =
    body.action === 'pause'
      ? await pauseCampaign(id, user.id)
      : await resumeCampaign(id, user.id);
  return Response.json(result);
}
