import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (!['start', 'pause', 'enable', 'disable'].includes(data?.action))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  if (data.action === 'start') {
    const { enqueueProzorroSync } = await import('@sonar/db/tasks');
    await enqueueProzorroSync(user.id);
  } else if (['enable', 'disable'].includes(data.action)) {
    await sonarPool.query(
      "update settings set value=$1::jsonb,updated_at=now() where key='prozorro.enabled'",
      [JSON.stringify(data.action === 'enable')],
    );
    const { logActivity } = await import('@sonar/db/tasks');
    await logActivity('settings.update', 'settings', null, user.id, {
      prozorroEnabled: data.action === 'enable',
    });
  } else {
    await sonarPool.query(
      "update settings set value='false'::jsonb,updated_at=now() where key='prozorro.full_sync.enabled'",
    );
    const { logActivity } = await import('@sonar/db/tasks');
    await logActivity('prozorro.pause', 'settings', null, user.id);
  }
  const { rows } = await sonarPool.query(
    'select key,value from settings where key=any($1)',
    [
      [
        'prozorro.full_sync.enabled',
        'prozorro.enabled',
        'prozorro.tender.progress',
        'prozorro.contract.progress',
      ],
    ],
  );
  return Response.json(
    Object.fromEntries(rows.map((row) => [row.key, row.value])),
    { status: 202 },
  );
}
