import { randomUUID } from 'node:crypto';
import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

const accountPath = /\/social-accounts\/([0-9a-f-]{36})\/browser\/dom$/i;
const service = () => {
  const url = process.env.SOCIAL_BROWSER_URL;
  const key = process.env.SOCIAL_BROWSER_KEY;
  return url && key ? { url, key } : null;
};
async function accountForOwner(id: string, userId: string) {
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select id from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin')",
    [id, userId],
  );
  return rows[0];
}
function accountId(request: Request) {
  return accountPath.exec(new URL(request.url).pathname)?.[1] ?? null;
}
async function owned(request: Request, userId: string) {
  const id = accountId(request);
  return id && validId(id) && (await accountForOwner(id, userId)) ? id : null;
}
function headers() {
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}
function snapshotsFrom(row: { snapshots?: unknown } | undefined) {
  return Array.isArray(row?.snapshots) ? row.snapshots : [];
}

/** List only the current user's saved, sanitized browser DOM snapshots. */
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user)
    return Response.json(
      { error: uk.unauthorized },
      { status: 401, headers: headers() },
    );
  const id = await owned(request, user.id);
  if (!id)
    return Response.json(
      { error: uk.unauthorized },
      { status: 403, headers: headers() },
    );
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select coalesce(settings->'manualDomSnapshots','[]'::jsonb) as snapshots from channel_accounts where id=$1 and owner_id=$2",
    [id, user.id],
  );
  const snapshots = snapshotsFrom(
    rows[0] as { snapshots?: unknown } | undefined,
  )
    .map((value) => value as Record<string, unknown>)
    .map(({ id: snapshotId, capturedAt, label, title, urlPattern }) => ({
      id: snapshotId,
      capturedAt,
      label,
      title,
      urlPattern,
    }));
  return Response.json(snapshots, { headers: headers() });
}

/** Capture the live page through the shared privacy sanitizer and retain the latest ten. */
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user)
    return Response.json(
      { error: uk.unauthorized },
      { status: 401, headers: headers() },
    );
  const id = await owned(request, user.id);
  if (!id)
    return Response.json(
      { error: uk.unauthorized },
      { status: 403, headers: headers() },
    );
  const input = (await request.json().catch(() => null)) as {
    label?: unknown;
  } | null;
  if (input && input.label !== undefined && typeof input.label !== 'string')
    return Response.json(
      { error: uk.ai.invalid },
      { status: 400, headers: headers() },
    );
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  if (label.length > 60)
    return Response.json(
      { error: uk.socialAccounts.domLabelTooLong },
      { status: 400, headers: headers() },
    );
  const config = service();
  if (!config)
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 503, headers: headers() },
    );
  try {
    const response = await fetch(new URL(`/profiles/${id}/dom`, config.url), {
      headers: { Authorization: `Bearer ${config.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(35000),
    });
    if (response.status === 404 || response.status === 409)
      return Response.json(
        { error: uk.socialAccounts.domNotRunning },
        { status: 409, headers: headers() },
      );
    if (!response.ok)
      return Response.json(
        { error: uk.socialAccounts.domUnavailable },
        { status: 502, headers: headers() },
      );
    const dom = (await response.json()) as Record<string, unknown>;
    if (
      !Array.isArray(dom.nodes) ||
      typeof dom.urlPattern !== 'string' ||
      typeof dom.title !== 'string'
    )
      return Response.json(
        { error: uk.socialAccounts.domUnavailable },
        { status: 502, headers: headers() },
      );
    const snapshot = {
      id: randomUUID(),
      phase: 'manual',
      urlPattern: dom.urlPattern,
      title: dom.title,
      capturedAt: new Date().toISOString(),
      label: label || null,
      dom,
    };
    const { sonarPool } = await import('@sonar/db');
    await sonarPool.query(
      `update channel_accounts set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{manualDomSnapshots}',(
        select coalesce(jsonb_agg(snapshot order by ordinal),'[]'::jsonb)
        from jsonb_array_elements(coalesce(settings->'manualDomSnapshots','[]'::jsonb) || $3::jsonb)
          with ordinality as saved(snapshot,ordinal)
        where ordinal > jsonb_array_length(coalesce(settings->'manualDomSnapshots','[]'::jsonb) || $3::jsonb)-10
      )) where id=$1 and owner_id=$2`,
      [id, user.id, JSON.stringify([snapshot])],
    );
    return Response.json(
      { id: snapshot.id, capturedAt: snapshot.capturedAt },
      { status: 201, headers: headers() },
    );
  } catch {
    return Response.json(
      { error: uk.socialAccounts.domUnavailable },
      { status: 502, headers: headers() },
    );
  }
}
