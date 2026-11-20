import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

const kinds = ['check', 'keepalive', 'inbox', 'send'] as const;
type Kind = (typeof kinds)[number];

/** The sanitized failed operation DOM, available only to the account owner. */
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
    "select settings->'failureShots'->$3->'dom' as dom from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram')",
    [id, user.id, kind],
  );
  if (!row?.dom)
    return Response.json({ error: uk.ai.invalid }, { status: 404, headers });
  return Response.json(row.dom, {
    headers: { ...headers, 'X-Content-Type-Options': 'nosniff' },
  });
}
