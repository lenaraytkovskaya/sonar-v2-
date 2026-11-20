import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

const pathPattern =
  /\/social-accounts\/([0-9a-f-]{36})\/browser\/dom\/([0-9a-f-]{36})$/i;
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
function ids(request: Request) {
  const match = pathPattern.exec(new URL(request.url).pathname);
  return match ? { accountId: match[1]!, snapshotId: match[2]! } : null;
}
async function owned(request: Request, userId: string) {
  const values = ids(request);
  if (!values || !validId(values.accountId) || !validId(values.snapshotId))
    return null;
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select id from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin')",
    [values.accountId, userId],
  );
  return rows[0] ? values : null;
}

/** Download a single sanitized snapshot belonging to the current account owner. */
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user)
    return Response.json({ error: uk.unauthorized }, { status: 401, headers });
  const values = await owned(request, user.id);
  if (!values)
    return Response.json({ error: uk.unauthorized }, { status: 403, headers });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select settings->'manualDomSnapshots' as snapshots from channel_accounts where id=$1 and owner_id=$2",
    [values.accountId, user.id],
  );
  const snapshots = Array.isArray(rows[0]?.snapshots) ? rows[0].snapshots : [];
  const snapshot = snapshots.find(
    (value: { id?: unknown }) => value?.id === values.snapshotId,
  );
  if (!snapshot)
    return Response.json({ error: uk.ai.invalid }, { status: 404, headers });
  return Response.json(snapshot, {
    headers: {
      ...headers,
      'Content-Disposition': `attachment; filename="social-page-${values.snapshotId}.json"`,
    },
  });
}

/** Delete only the selected snapshot, without changing other account settings. */
export async function DELETE(request: Request) {
  const user = await apiUser(request, true);
  if (!user)
    return Response.json({ error: uk.unauthorized }, { status: 401, headers });
  const values = await owned(request, user.id);
  if (!values)
    return Response.json({ error: uk.unauthorized }, { status: 403, headers });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    `update channel_accounts set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{manualDomSnapshots}',(
      select coalesce(jsonb_agg(snapshot),'[]'::jsonb)
      from jsonb_array_elements(coalesce(settings->'manualDomSnapshots','[]'::jsonb)) with ordinality as saved(snapshot,ordinal)
      where snapshot->>'id' <> $3
      order by ordinal
    )) where id=$1 and owner_id=$2 and exists(
      select 1 from jsonb_array_elements(coalesce(settings->'manualDomSnapshots','[]'::jsonb)) as saved(snapshot)
      where snapshot->>'id'=$3
    ) returning id`,
    [values.accountId, user.id, values.snapshotId],
  );
  if (!rows.length)
    return Response.json({ error: uk.ai.invalid }, { status: 404, headers });
  return Response.json({ deleted: true }, { headers });
}
