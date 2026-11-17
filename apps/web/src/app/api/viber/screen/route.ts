import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const url = process.env.VIBER_BRIDGE_URL,
    key = process.env.VIBER_BRIDGE_KEY;
  if (!url || !key)
    return Response.json(
      { error: uk.viber.bridgeUnavailable },
      { status: 503 },
    );
  try {
    const failure =
      new URL(request.url).searchParams.get('lastFailure') === '1';
    const response = await fetch(
      new URL(failure ? '/screen?lastFailure=1' : '/screen', url),
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
