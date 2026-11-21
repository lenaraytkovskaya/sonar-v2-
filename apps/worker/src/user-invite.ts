import {
  EmailSendError,
  sendResendEmail,
  type EmailRequest,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { boss, runTask, type TaskOutcome } from '@sonar/db/tasks';

export async function runUserInviteSend(
  input: { inviteId: string },
  send?: (request: EmailRequest) => Promise<string>,
): Promise<TaskOutcome> {
  const {
    rows: [invite],
  } = await sonarPool.query(
    'select id,email,token,expires_at from user_invites where id=$1 and accepted_at is null',
    [input.inviteId],
  );
  if (!invite || new Date(invite.expires_at).getTime() <= Date.now())
    return {
      status: 'skipped',
      reasonCode: 'invite_closed',
      reasonUk: 'Запрошення вже прийнято, скасовано або прострочено.',
    };
  if (!send && !process.env.RESEND_API_TOKEN)
    return {
      status: 'paused',
      reasonCode: 'resend_key_missing',
      reasonUk: 'Додайте ключ Resend перед надсиланням запрошень.',
    };
  const {
    rows: [account],
  } = await sonarPool.query(
    "select address from channel_accounts where channel='email' and status='active' order by created_at limit 1",
  );
  if (!account?.address)
    return {
      status: 'paused',
      reasonCode: 'invite_sender_missing',
      reasonUk:
        'Додайте активну поштову скриньку, з якої надсилати запрошення.',
    };
  const base = (process.env.APP_URL ?? '').trim().replace(/\/$/, '');
  // A relative link in the mail is useless: never send one.
  if (!/^https?:\/\/[^\s/]+/.test(base))
    return {
      status: 'paused',
      reasonCode: 'invite_url_missing',
      reasonUk: 'Не задано адресу Sonar (APP_URL) для посилання в запрошенні.',
    };
  try {
    await (
      send ??
      ((request) => sendResendEmail(request, process.env.RESEND_API_TOKEN!))
    )({
      from: account.address,
      to: invite.email,
      subject: 'Запрошення до Sonar',
      body: `Вас запрошено до Sonar. Створіть пароль і увійдіть за посиланням:\n\n${base}/invite/${invite.token}\n\nПосилання діє обмежений час і працює один раз.`,
      idempotencyKey: `user-invite:${invite.id}`,
    });
  } catch (error) {
    if (error instanceof EmailSendError)
      return {
        status: 'failed',
        reasonCode: error.code,
        reasonUk: error.reasonUk,
      };
    throw error;
  }
  await sonarPool.query('update user_invites set sent_at=now() where id=$1', [
    invite.id,
  ]);
  return { status: 'done', result: { inviteId: invite.id } };
}

export async function registerUserInviteTasks() {
  await boss.createQueue('user.invite.send');
  await runTask('user.invite.send', (payload) =>
    runUserInviteSend(payload as { inviteId: string }),
  );
}
