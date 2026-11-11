import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select status,result,reason_uk from tasks where id=$1 and payload->>'userId'=$2",
    [id, user.id],
  );
  return rows[0]
    ? Response.json(rows[0])
    : Response.json({ error: uk.tasks.missing }, { status: 404 });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    !data ||
    !validId(data.requestId) ||
    !['improve', 'shorter', 'warmer', 'translate', 'custom'].includes(
      data.action,
    ) ||
    typeof data.text !== 'string' ||
    !data.text.trim() ||
    data.text.length > 20000 ||
    (data.instruction !== undefined &&
      (typeof data.instruction !== 'string' || data.instruction.length > 1000))
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { enqueueTask } = await import('@sonar/db/tasks');
  const key = `ai:${user.id}:${data.requestId}`;
  await enqueueTask('ai.assist', key, {
    action: data.action,
    text: data.text,
    instruction: data.instruction ?? '',
    userId: user.id,
  });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    'select id from tasks where idempotency_key=$1',
    [key],
  );
  return Response.json({ id: rows[0].id }, { status: 202 });
}
