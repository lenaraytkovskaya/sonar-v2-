import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    typeof data?.enabled !== 'boolean' ||
    !Array.isArray(data.allowlist) ||
    data.allowlist.length > 200 ||
    data.allowlist.some(
      (entry: unknown) =>
        typeof entry !== 'string' || !entry.trim() || entry.length > 300,
    )
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const { logActivity } = await import('@sonar/db/tasks');
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    for (const [key, value] of [
      ['send.test_mode', data.enabled],
      ['send.test_allowlist', data.allowlist.map((e: string) => e.trim())],
    ])
      await client.query(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value,updated_at=now()',
        [key, JSON.stringify(value)],
      );
    await logActivity(
      'settings.test_mode',
      'settings',
      null,
      user.id,
      { enabled: data.enabled, count: data.allowlist.length },
      client,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return Response.json({ ok: true });
}
