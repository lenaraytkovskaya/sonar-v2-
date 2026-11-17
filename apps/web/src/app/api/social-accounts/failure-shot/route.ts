import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

const kinds = ['check', 'keepalive', 'inbox', 'send'] as const;
type Kind = (typeof kinds)[number];

/** The latest failed operation page, available only to the account owner. */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const user = await apiUser(request);
  if (!user)
    return Response.json({ error: uk.unauthorized }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const kind = params.get('kind') as Kind | null;
  if (!validId(id) || !kind || !kinds.includes(kind))
    return Response.json({ error: uk.ai.invalid }, { status: 400, headers });
  const { sonarPool } = await import('@sonar/db');
  const {
    rows: [row],
  } = await sonarPool.query(
    "select settings->'failureShots'->$3->>'jpeg' as jpeg from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin')",
    [id, user.id, kind],
  );
  if (!row?.jpeg)
    return Response.json({ error: uk.ai.invalid }, { status: 404, headers });
  return new Response(Buffer.from(row.jpeg, 'base64'), {
    headers: { ...headers, 'Content-Type': 'image/jpeg' },
  });
}
