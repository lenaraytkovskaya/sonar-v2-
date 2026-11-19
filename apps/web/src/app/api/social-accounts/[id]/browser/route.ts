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
async function streamService(path: string, signal: AbortSignal) {
  const config = service();
  if (!config) throw new Error('unavailable');
  return fetch(new URL(path, config.url), {
    headers: { Authorization: `Bearer ${config.key}` },
    cache: 'no-store',
    signal,
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
    const response = await streamService(
      `/profiles/${account.id}/screen`,
      request.signal,
    );
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
    return new Response(response.body, {
      headers: {
        'Content-Type':
          response.headers.get('content-type') ??
          'multipart/x-mixed-replace; boundary=sonar-frame',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
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
    !['open', 'close', 'mouse', 'wheel', 'text', 'key', 'navigate'].includes(
      String(input.action),
    )
  )
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 400 },
    );
  if (
    ['mouse', 'wheel'].includes(String(input.action)) &&
    (!Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      Number(input.x) < 0 ||
      Number(input.y) < 0 ||
      Number(input.x) > 1280 ||
      Number(input.y) > 800 ||
      (input.action === 'mouse' &&
        !['move', 'down', 'up', 'click', 'doubleClick'].includes(
          String(input.type),
        )) ||
      (input.action === 'mouse' &&
        input.button !== undefined &&
        !['left', 'middle', 'right'].includes(String(input.button))) ||
      (input.action === 'wheel' &&
        (typeof input.deltaX !== 'number' ||
          Math.abs(input.deltaX) > 2000 ||
          typeof input.deltaY !== 'number' ||
          Math.abs(input.deltaY) > 2000)))
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
    !(
      input.selectAll === true ||
      [
        'Enter',
        'Tab',
        'Backspace',
        'Delete',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
      ].includes(String(input.key))
    )
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
      const locked = await callService(`/profiles/${account.id}/lock`, {
        method: 'POST',
        headers: { 'X-Sonar-Viewer': 'true' },
      });
      if (locked.status === 409)
        return Response.json(
          { error: uk.socialAccounts.browserBusy },
          { status: 409 },
        );
      if (!locked.ok)
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
    if (input.action === 'close') {
      const response = await callService(
        `/profiles/${account.id}/viewer-unlock`,
        { method: 'POST' },
      );
      if (!response.ok)
        return Response.json(
          { error: uk.socialAccounts.browserUnavailable },
          { status: 502 },
        );
      return Response.json({ accepted: true });
    }
    const payload =
      input.action === 'mouse'
        ? { type: input.type, x: input.x, y: input.y, button: input.button }
        : input.action === 'wheel'
          ? {
              type: 'wheel',
              x: input.x,
              y: input.y,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            }
          : input.action === 'text'
            ? { type: 'text', text: input.text }
            : input.action === 'key'
              ? { type: 'key', key: input.key, selectAll: input.selectAll }
              : { navigate: input.url };
    const response = await callService(`/profiles/${account.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, viewer: true }),
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
    if (input.action === 'open')
      await callService(`/profiles/${account.id}/viewer-unlock`, {
        method: 'POST',
      }).catch(() => {});
    return Response.json(
      { error: uk.socialAccounts.browserUnavailable },
      { status: 502 },
    );
  }
}
