'use server';
import { hash } from 'argon2';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { uk } from '@/i18n/uk';

export async function acceptInvite(
  token: string,
  _previous: string,
  form: FormData,
): Promise<string> {
  const name = String(form.get('name') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  if (!name || name.length > 200) return uk.invite.name_required;
  if (password.length > 1024) return uk.invite.long;
  if (password !== confirm) return uk.invite.mismatch;
  let userId: string;
  try {
    const db = await import('@sonar/db/user-invites');
    const min = await db.getPasswordMinLength();
    if (password.length < min)
      return uk.invite.short.replace('{min}', String(min));
    const result = await db.acceptInvite(token, name, await hash(password));
    if ('error' in result) return uk.invite[result.error];
    userId = result.userId;
  } catch {
    return uk.invite.failed;
  }
  const session = await getSession();
  session.user = { id: userId, name };
  await session.save();
  redirect('/');
}
