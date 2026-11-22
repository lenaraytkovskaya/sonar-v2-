import { apiUser, validId } from '@/lib/api-access';
import { BudgetExceeded } from '@sonar/core';
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
  const body = await request.json().catch(() => null);
  if (!validId(body?.requestId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { createBatch, ContinuationUnavailable, CampaignProductRequired } =
    await import('@sonar/db/batches');
  try {
    return Response.json(await createBatch(id, user.id, body.requestId), {
      status: 202,
    });
  } catch (error) {
    if (error instanceof BudgetExceeded)
      return Response.json(
        { error: uk.google.preflightBudget },
        { status: 409 },
      );
    if (error instanceof ContinuationUnavailable)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof CampaignProductRequired)
      return Response.json(
        { error: uk.campaign.productRequired },
        { status: 409 },
      );
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  }
}
