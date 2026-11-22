import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const campaignId = params.get('campaignId');
  if (campaignId !== null && !validId(campaignId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { taskOverviewData } = await import('@sonar/db/task-overview');
  const data = await taskOverviewData({
    campaignId: campaignId ?? undefined,
    status: params.get('status') || null,
    type: params.get('type') || null,
  });
  if (!data)
    return Response.json({ error: uk.tasks.campaignMissing }, { status: 404 });
  if (campaignId) return Response.json(data);
  const { sonarPool } = await import('@sonar/db');
  const { readWorkerHealth } = await import('@sonar/db/tasks');
  const { countSentToday } = await import('@sonar/db/email');
  const { rows: unread } = await sonarPool.query(
    "select count(*)::int as count from messages where direction='in' and read_at is null",
  );
  return Response.json({
    ...data,
    workerHealth: await readWorkerHealth(),
    sentToday: await countSentToday(),
    unreadCount: unread[0].count,
  });
}
