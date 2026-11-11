'use server';
import { randomBytes } from 'node:crypto';
import { hash, verify } from 'argon2';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { safeReturnTo } from '@/lib/session';
import { uk } from '@/i18n/uk';
let dummyHash: Promise<string> | undefined;
export async function login(
  _previous: string,
  form: FormData,
): Promise<string> {
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(form.get('password') ?? '');
  if (!email || email.length > 254 || !password || password.length > 1024)
    return uk.login.invalid;
  try {
    const { sonarPool } = await import('@sonar/db');
    const { rows } = await sonarPool.query<{
      id: string;
      name: string;
      password_hash: string;
    }>(
      'select id, name, password_hash from users where lower(email) = $1 limit 1',
      [email],
    );
    const user = rows[0];
    dummyHash ??= hash(randomBytes(32));
    const valid = await verify(
      user?.password_hash ?? (await dummyHash),
      password,
    );
    if (!user || !valid) return uk.login.invalid;
    const session = await getSession();
    session.user = { id: user.id, name: user.name };
    const { logActivity } = await import('@sonar/db/tasks');
    await logActivity('user.login', 'user', user.id, user.id);
    await session.save();
  } catch {
    return uk.login.unavailable;
  }
  redirect(safeReturnTo(form.get('next')));
}
export async function logout() {
  const session = await getSession();
  if (session.user) {
    const { logActivity } = await import('@sonar/db/tasks');
    await logActivity('user.logout', 'user', session.user.id, session.user.id);
  }
  session.destroy();
  redirect('/login');
}
