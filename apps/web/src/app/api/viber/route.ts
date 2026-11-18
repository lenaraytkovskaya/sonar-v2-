import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { listViberAccounts } = await import('@sonar/db/viber');
  const accounts = await listViberAccounts();
  const url = process.env.VIBER_BRIDGE_URL,
    key = process.env.VIBER_BRIDGE_KEY;
  let bridge: { state: string; reason: string } = {
    state: 'error',
    reason: uk.viber.bridgeUnavailable,
  };
  if (!key?.trim()) bridge = { state: 'error', reason: 'bridge_key_missing' };
  if (url && key?.trim()) {
    try {
      const response = await fetch(new URL('/status', url), {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) bridge = await response.json();
    } catch {
      /* status response stays safely unavailable */
    }
  }
  return Response.json(
    { accounts, bridge },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    !data ||
    Object.keys(data).some((key) => !['dailyLimit', 'paused'].includes(key)) ||
    Object.keys(data).length === 0 ||
    (data.dailyLimit !== undefined && !Number.isInteger(data.dailyLimit)) ||
    (data.paused !== undefined && typeof data.paused !== 'boolean')
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { updateViberAccount, listViberAccounts } =
    await import('@sonar/db/viber');
  try {
    await updateViberAccount(user.id, data);
    return Response.json(
      { accounts: await listViberAccounts() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : uk.ai.invalid },
      { status: 400 },
    );
  }
}
