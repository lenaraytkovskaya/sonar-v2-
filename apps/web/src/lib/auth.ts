import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions, type SessionData } from './session';
export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

export async function getSessionUser(id: unknown) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
  )
    return null;
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query<{ id: string; name: string }>(
    'select id,name from users where id=$1',
    [id],
  );
  return rows[0] ?? null;
}
