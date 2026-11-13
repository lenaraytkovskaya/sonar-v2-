import {
  resolveSocialSession,
  SocialSendError,
} from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import { sendEmailMessage, type ChannelSender } from '@sonar/db/email';
import { withSocialSessionCheck } from '@sonar/db/social-accounts';
import { boss, runTask, type TaskOutcome } from '@sonar/db/tasks';
import {
  socialSendBrowser,
  type SocialSessionAccount,
} from './social-send-browser.js';

async function timeout() {
  const {
    rows: [setting],
  } = await sonarPool.query(
    "select value from settings where key='social.page_timeout_ms'",
  );
  const value = Number(setting?.value);
  if (!Number.isSafeInteger(value) || value < 100 || value > 120000)
    throw new SocialSendError(
      'session_invalid',
      'Перевірте таймаут соцмереж у налаштуваннях.',
    );
  return value;
}
export async function runSocialSend(
  input: { messageId: string },
  taskId: string,
  send?: ChannelSender,
  now?: Date,
): Promise<TaskOutcome> {
  return sendEmailMessage(
    input.messageId,
    taskId,
    send ??
      (async (request, account) => {
        if (!account?.beforeSend)
          throw new SocialSendError(
            'session_invalid',
            'Не налаштовано безпечне підтвердження спроби надсилання.',
          );
        const network = account.settings.network;
        if (
          network !== 'instagram' &&
          network !== 'facebook' &&
          network !== 'linkedin'
        )
          throw new SocialSendError(
            'session_invalid',
            'Увійдіть знову (оновіть cookies)',
          );
        const sessionAccount: SocialSessionAccount = {
          ...account,
          channel: network,
        };
        return socialSendBrowser.send(
          sessionAccount,
          resolveSocialSession(sessionAccount),
          await timeout(),
          request.to,
          request.body,
          account.beforeSend,
        );
      }),
    now,
    Math.random,
    'social',
  );
}
export async function runSocialSessionCheck(input: { accountId: string }) {
  return withSocialSessionCheck(input.accountId, async (account) => {
    try {
      await socialSendBrowser.check(
        account,
        resolveSocialSession(account),
        await timeout(),
      );
      return { valid: true };
    } catch {
      return {
        valid: false,
        reason:
          'Сесію не підтверджено. Перевірте cookies, проксі та ручну перевірку в соцмережі.',
      };
    }
  });
}
export async function registerSocialSessionTasks() {
  await boss.createQueue('social.session.check');
  await runTask('social.session.check', (payload) =>
    runSocialSessionCheck(payload as { accountId: string }),
  );
}
export const closeSocialSendBrowser = () => socialSendBrowser.close();
