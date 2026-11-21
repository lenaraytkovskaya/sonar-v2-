import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import type { EmailRequest } from '@sonar/core';

const enabled = process.env.RUN_DB_TESTS === '1';
const ids: string[] = [];
const accounts: string[] = [];

afterAll(async () => {
  if (!enabled) return;
  const { sonarPool } = await import('@sonar/db');
  await sonarPool.query('delete from user_invites where id=any($1::uuid[])', [
    ids,
  ]);
  await sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [accounts],
  );
});

it.skipIf(!enabled)(
  'sends the invite link from an active mailbox and records the send',
  async () => {
    const { sonarPool } = await import('@sonar/db');
    const { runUserInviteSend } = await import('./user-invite.js');
    delete process.env.APP_URL;
    const {
      rows: [invite],
    } = await sonarPool.query(
      `insert into user_invites(email,token,expires_at)
       values($1,$2,now()+interval '1 day') returning id,token`,
      [`${randomUUID()}@example.invalid`, randomUUID().replace(/-/g, '')],
    );
    ids.push(invite.id);
    const send = vi.fn(async (request: EmailRequest) => `sent-${request.to}`);
    const {
      rows: [account],
    } = await sonarPool.query(
      "insert into channel_accounts(channel,name,address,status,daily_limit,settings) values('email','Invite sender',$1,'active',20,'{}'::jsonb) returning id",
      [`from-${randomUUID()}@example.invalid`],
    );
    accounts.push(account.id);
    expect(
      await runUserInviteSend({ inviteId: invite.id }, send),
    ).toMatchObject({
      status: 'paused',
      reasonCode: 'invite_url_missing',
    });
    expect(send).not.toHaveBeenCalled();
    process.env.APP_URL = 'https://sonar.example';
    expect(
      await runUserInviteSend({ inviteId: invite.id }, send),
    ).toMatchObject({
      status: 'done',
    });
    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]![0];
    expect(request.body).toContain(
      `https://sonar.example/invite/${invite.token}`,
    );
    expect(
      (
        await sonarPool.query('select sent_at from user_invites where id=$1', [
          invite.id,
        ])
      ).rows[0].sent_at,
    ).not.toBeNull();
    await sonarPool.query(
      'update user_invites set accepted_at=now() where id=$1',
      [invite.id],
    );
    expect(
      await runUserInviteSend({ inviteId: invite.id }, send),
    ).toMatchObject({
      status: 'skipped',
      reasonCode: 'invite_closed',
    });
  },
);
