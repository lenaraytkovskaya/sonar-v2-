import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

/** The page Sonar saw when the last credential login failed; only the account owner can open it. */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const user = await apiUser(request);
  if (!user)
    return Response.json({ error: uk.unauthorized }, { status: 401, headers });
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400, headers });
  const { sonarPool } = await import('@sonar/db');
  const {
    rows: [row],
  } = await sonarPool.query(
    "select settings->'loginShot'->>'jpeg' as jpeg from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin')",
    [id, user.id],
  );
  if (!row?.jpeg)
    return Response.json({ error: uk.ai.invalid }, { status: 404, headers });
  return new Response(Buffer.from(row.jpeg, 'base64'), {
    headers: { ...headers, 'Content-Type': 'image/jpeg' },
  });
}
