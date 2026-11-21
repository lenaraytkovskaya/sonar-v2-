import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
const emails: string[] = [];
let inviter: string | undefined;

afterAll(async () => {
  if (!enabled) return;
  const { sonarPool } = await import('./index.js');
  await sonarPool.query(
    'delete from tasks where type=$1 and idempotency_key in (select $2 || id::text from user_invites where lower(email)=any($3::text[]))',
    ['user.invite.send', 'user.invite.send:', emails],
  );
  await sonarPool.query(
    'delete from user_invites where lower(email)=any($1::text[])',
    [emails],
  );
  await sonarPool.query(
    'delete from users where lower(email)=any($1::text[])',
    [emails],
  );
});

it.skipIf(!enabled)(
  'invites by email, replaces repeats, creates the user once and rejects bad links',
  async () => {
    const { sonarPool } = await import('./index.js');
    const invites = await import('./user-invites.js');
    const address = `${randomUUID()}@example.invalid`;
    emails.push(address);
    const {
      rows: [owner],
    } = await sonarPool.query(
      "insert into users(email,name,password_hash) values($1,'Inviter','unusable') returning id",
      [`${randomUUID()}@example.invalid`],
    );
    inviter = owner.id;
    emails.push(
      (await sonarPool.query('select email from users where id=$1', [inviter]))
        .rows[0].email,
    );

    expect(await invites.createInvite('not-an-email', inviter!)).toEqual({
      error: 'invalid',
    });
    const first = await invites.createInvite(address.toUpperCase(), inviter!);
    expect('id' in first).toBe(true);
    const second = await invites.createInvite(address, inviter!);
    expect('id' in second && 'id' in first && second.id !== first.id).toBe(
      true,
    );
    const list = await invites.listUsersAndInvites();
    expect(list.invites.filter((row) => row.email === address)).toHaveLength(1);
    const {
      rows: [open],
    } = await sonarPool.query(
      'select token from user_invites where lower(email)=$1',
      [address],
    );
    expect(
      (
        await sonarPool.query(
          "select status from tasks where type='user.invite.send' and payload->>'inviteId'=$1",
          [(second as { id: string }).id],
        )
      ).rows,
    ).toHaveLength(1);

    expect(await invites.getOpenInvite('missing-token')).toEqual({
      error: 'invalid',
    });
    expect(await invites.getOpenInvite(open.token)).toMatchObject({
      invite: { email: address },
    });
    const accepted = await invites.acceptInvite(open.token, 'Newcomer', 'hash');
    expect('userId' in accepted).toBe(true);
    expect(await invites.acceptInvite(open.token, 'Again', 'hash')).toEqual({
      error: 'invalid',
    });
    expect(await invites.createInvite(address, inviter!)).toEqual({
      error: 'exists',
    });

    const later = `${randomUUID()}@example.invalid`;
    emails.push(later);
    await invites.createInvite(later, inviter!);
    await sonarPool.query(
      "update user_invites set expires_at=now()-interval '1 minute' where email=$1",
      [later],
    );
    const {
      rows: [stale],
    } = await sonarPool.query('select token from user_invites where email=$1', [
      later,
    ]);
    expect(await invites.getOpenInvite(stale.token)).toEqual({
      error: 'expired',
    });
    expect(await invites.acceptInvite(stale.token, 'Late', 'hash')).toEqual({
      error: 'expired',
    });
    expect(await invites.getPasswordMinLength()).toBe(8);
  },
);
