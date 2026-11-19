import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

async function ownsViberChannel(userId: string) {
  const { sonarPool } = await import('@sonar/db');
  let { rows } = await sonarPool.query(
    `select 1 from channel_accounts where channel='viber' and owner_id=$1 limit 1`,
    [userId],
  );
  if (!rows.length) {
    await sonarPool.query(
      `update channel_accounts set owner_id=$1 where channel='viber' and owner_id is null
        and (select count(*) from users)=1`,
      [userId],
    );
    ({ rows } = await sonarPool.query(
      `select 1 from channel_accounts where channel='viber' and owner_id=$1 limit 1`,
      [userId],
    ));
  }
  return rows.length > 0;
}

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  if (!(await ownsViberChannel(user.id)))
    return Response.json({ error: uk.unauthorized }, { status: 403 });
  const url = process.env.VIBER_BRIDGE_URL,
    key = process.env.VIBER_BRIDGE_KEY;
  if (!url || !key)
    return Response.json(
      { error: uk.viber.bridgeUnavailable },
      { status: 503 },
    );
  try {
    const query = new URL(request.url).searchParams;
    const failure = query.get('lastFailure') === '1';
    const attention = query.get('attention') === '1';
    const response = await fetch(
      new URL(
        attention
          ? '/screen?attention=1'
          : failure
            ? '/screen?lastFailure=1'
            : '/screen',
        url,
      ),
      {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      return Response.json(
        { error: uk.viber.screenUnavailable },
        { status: 502 },
      );
    return new Response(response.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: uk.viber.screenUnavailable },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const input = await request.json().catch(() => null);
  if (
    !input ||
    input.screenOpen !== true ||
    Object.keys(input).some(
      (key) =>
        !['x', 'y', 'width', 'height', 'key', 'screenOpen'].includes(key),
    ) ||
    (input.key !== undefined && !['Escape', 'Enter'].includes(input.key))
  )
    return Response.json(
      { error: uk.viber.screenUnavailable },
      { status: 400 },
    );
  if (!(await ownsViberChannel(user.id)))
    return Response.json({ error: uk.unauthorized }, { status: 403 });
  const url = process.env.VIBER_BRIDGE_URL,
    key = process.env.VIBER_BRIDGE_KEY;
  if (!url || !key)
    return Response.json(
      { error: uk.viber.bridgeUnavailable },
      { status: 503 },
    );
  try {
    const response = await fetch(new URL('/click', url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch {
    return Response.json(
      { error: uk.viber.screenUnavailable },
      { status: 502 },
    );
  }
}
