'use server';
import { randomBytes } from 'node:crypto';
import { hash, verify } from 'argon2';
import { headers } from 'next/headers';
import { loginLimiter, loginClientIp } from '@/lib/login-limiter';
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
  const finish = loginLimiter.begin(
    email.slice(0, 254),
    loginClientIp(await headers()),
  );
  if (!finish) return uk.login.limited;
  let success = false;
  try {
    if (!email || email.length > 254 || !password || password.length > 1024)
      return uk.login.invalid;
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
    await session.save();
    success = true;
  } catch {
    return uk.login.unavailable;
  } finally {
    finish(success);
  }
  redirect(safeReturnTo(form.get('next')));
}
export async function logout() {
  const session = await getSession();
  session.destroy();
  redirect('/login');
}
