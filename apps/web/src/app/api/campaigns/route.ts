import { apiUser, validId } from '@/lib/api-access';
import { campaignSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { sonarPool } = await import('@sonar/db');
  const { rows: campaigns } = await sonarPool.query(
    'select * from campaigns order by created_at desc',
  );
  return Response.json({ campaigns });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = campaignSchema.safeParse(body?.data);
  if (!parsed.success || (body?.id && !validId(body.id)))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { saveCampaign } = await import('@sonar/db/campaigns');
  return Response.json(
    await saveCampaign(
      parsed.data,
      body.id || null,
      user.id,
      body.source === 'ai' ? 'ai' : 'form',
    ),
  );
}
