import { resolveSocialSession } from '@sonar/core/social-session';
import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

type Network = 'facebook' | 'instagram' | 'linkedin';
function service() {
  const url = process.env.SOCIAL_BROWSER_URL;
  const key = process.env.SOCIAL_BROWSER_KEY;
  if (!url || !key) return null;
  return { url, key };
}
async function ownedAccount(userId: string, id: string) {
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select id,channel,settings from channel_accounts where id=$1 and owner_id=$2 and channel in ('facebook','instagram','linkedin')",
    [id, userId],
  );
  return rows[0] as
    | { id: string; channel: Network; settings: Record<string, unknown> }
    | undefined;
}
function accountId(request: Request) {
  const value = new URL(request.url).pathname.split('/').at(-2);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}
async function callService(path: string, init?: RequestInit) {
  const config = service();
  if (!config) throw new Error('unavailable');
  return fetch(new URL(path, config.url), {
    ...init,
    headers: {
      Authorization: `Bearer ${config.key}`,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(35000),
  });
}
export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const id = accountId(request);
  const account = id && (await ownedAccount(user.id, id));
  if (!account)
    return Response.json({ error: uk.unauthorized }, { status: 403 });
  if (!service())
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 503 },
    );
  try {
    const response = await callService(`/profiles/${account.id}/screen`);
    if (!response.ok)
      return Response.json(
        { error: uk.socialAccounts.browserUnavailable },
        { status: 502 },
      );
    return new Response(response.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 502 },
    );
  }
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const id = accountId(request);
  const account = id && (await ownedAccount(user.id, id));
  if (!account)
    return Response.json({ error: uk.unauthorized }, { status: 403 });
  const input = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !input ||
    !['open', 'click', 'text', 'key', 'navigate'].includes(String(input.action))
  )
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  if (
    input.action === 'click' &&
    (!Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      Number(input.x) < 0 ||
      Number(input.y) < 0 ||
      Number(input.x) > 1280 ||
      Number(input.y) > 800)
  )
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  if (
    input.action === 'text' &&
    (typeof input.text !== 'string' || input.text.length > 4096)
  )
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  if (
    input.action === 'key' &&
    !['Enter', 'Tab', 'Backspace', 'Escape'].includes(String(input.key))
  )
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  if (input.action === 'navigate' && typeof input.url !== 'string')
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  const config = service();
  if (!config)
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 503 },
    );
  try {
    if (input.action === 'open') {
      const session = resolveSocialSession(account);
      const { sonarPool } = await import('@sonar/db');
      const { rows } = await sonarPool.query(
        "select key,value from settings where key in ('social.browser.max_profiles','social.browser.idle_ms')",
      );
      const values = Object.fromEntries(
        rows.map((row) => [row.key, Number(row.value)]),
      );
      const started = await callService('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: account.id,
          network: account.channel,
          proxy: session.proxy,
          maxProfiles: values['social.browser.max_profiles'] ?? 3,
          idleMs: values['social.browser.idle_ms'] ?? 1800000,
        }),
      });
      if (!started.ok)
        return Response.json(
          { error: uk.socialAccounts.browserUnavailable },
          { status: 502 },
        );
      await sonarPool.query(
        "update channel_accounts set settings=settings||jsonb_build_object('browserProfile',true) where id=$1 and owner_id=$2",
        [account.id, user.id],
      );
      return Response.json({ accepted: true });
    }
    const payload =
      input.action === 'click'
        ? { x: input.x, y: input.y }
        : input.action === 'text'
          ? { text: input.text }
          : input.action === 'key'
            ? { key: input.key }
            : { navigate: input.url };
    const response = await callService(`/profiles/${account.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 409)
      return Response.json(
        { error: uk.socialAccounts.browserBusy },
        { status: 409 },
      );
    if (!response.ok)
      return Response.json(
        { error: uk.socialAccounts.browserUnavailable },
        { status: 502 },
      );
    return Response.json({ accepted: true });
  } catch {
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 502 },
    );
  }
}
