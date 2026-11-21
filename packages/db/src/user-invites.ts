import { randomBytes } from 'node:crypto';
import { sonarPool } from './index.js';
import { enqueueTask, logActivity } from './tasks.js';

export type InviteError = 'exists' | 'invalid' | 'expired';

async function numberSetting(key: string, fallback: number) {
  const {
    rows: [row],
  } = await sonarPool.query('select value from settings where key=$1', [key]);
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const getPasswordMinLength = () =>
  numberSetting('auth.password_min_length', 8);

export async function listUsersAndInvites() {
  const [users, invites] = await Promise.all([
    sonarPool.query(
      'select id,email,name,created_at as "createdAt" from users order by created_at',
    ),
    sonarPool.query(
      `select id,email,created_at as "createdAt",expires_at as "expiresAt",sent_at as "sentAt"
       from user_invites where accepted_at is null order by created_at desc`,
    ),
  ]);
  return { users: users.rows, invites: invites.rows };
}

/** One open invite per email: a repeat invite replaces the previous link. */
export async function createInvite(
  email: string,
  invitedBy: string,
): Promise<{ id: string } | { error: InviteError }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254)
    return { error: 'invalid' };
  const {
    rows: [existing],
  } = await sonarPool.query('select 1 from users where lower(email)=$1', [
    normalized,
  ]);
  if (existing) return { error: 'exists' };
  // 0 hours means the link never expires.
  const {
    rows: [ttlRow],
  } = await sonarPool.query(
    "select value from settings where key='auth.invite_ttl_hours'",
  );
  const configured = Number(ttlRow?.value);
  const ttlHours =
    Number.isSafeInteger(configured) && configured >= 0 ? configured : 72;
  const token = randomBytes(32).toString('base64url');
  const c = await sonarPool.connect();
  try {
    await c.query('begin');
    await c.query(
      'delete from user_invites where lower(email)=$1 and accepted_at is null',
      [normalized],
    );
    const {
      rows: [invite],
    } = await c.query(
      `insert into user_invites(email,token,invited_by,expires_at)
       values($1,$2,$3,case when $4::int=0 then null else now()+make_interval(hours=>$4::int) end) returning id`,
      [normalized, token, invitedBy, ttlHours],
    );
    await enqueueTask(
      'user.invite.send',
      `user.invite.send:${invite.id}`,
      { inviteId: invite.id },
      c,
    );
    await logActivity(
      'user.invite',
      'user_invite',
      invite.id,
      invitedBy,
      {},
      c,
    );
    await c.query('commit');
    return { id: invite.id };
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

export async function revokeInvite(id: string, userId: string) {
  const { rowCount } = await sonarPool.query(
    'delete from user_invites where id=$1 and accepted_at is null',
    [id],
  );
  if (rowCount)
    await logActivity('user.invite.revoke', 'user_invite', id, userId);
  return Boolean(rowCount);
}

export async function getOpenInvite(token: string) {
  const {
    rows: [invite],
  } = await sonarPool.query(
    'select id,email,expires_at as "expiresAt" from user_invites where token=$1 and accepted_at is null',
    [token],
  );
  if (!invite) return { error: 'invalid' as const };
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now())
    return { error: 'expired' as const };
  return { invite: { id: invite.id as string, email: invite.email as string } };
}

/** Creates the user from an open invite and closes it in one transaction. */
export async function acceptInvite(
  token: string,
  name: string,
  passwordHash: string,
): Promise<{ userId: string } | { error: InviteError }> {
  const c = await sonarPool.connect();
  try {
    await c.query('begin');
    const {
      rows: [invite],
    } = await c.query(
      'select id,email,expires_at from user_invites where token=$1 and accepted_at is null for update',
      [token],
    );
    if (!invite) {
      await c.query('rollback');
      return { error: 'invalid' };
    }
    if (
      invite.expires_at &&
      new Date(invite.expires_at).getTime() <= Date.now()
    ) {
      await c.query('rollback');
      return { error: 'expired' };
    }
    const {
      rows: [user],
    } = await c.query(
      `insert into users(email,name,password_hash) values($1,$2,$3)
       on conflict do nothing returning id`,
      [invite.email, name, passwordHash],
    );
    if (!user) {
      await c.query('rollback');
      return { error: 'exists' };
    }
    await c.query('update user_invites set accepted_at=now() where id=$1', [
      invite.id,
    ]);
    await logActivity('user.invite.accept', 'user', user.id, user.id, {}, c);
    await c.query('commit');
    return { userId: user.id };
  } catch (error) {
    await c.query('rollback').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
