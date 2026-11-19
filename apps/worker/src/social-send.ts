import {
  SocialProfileBusyError,
  resolveSocialSession,
  SocialSendError,
  socialSessionCheckReason,
  SocialSessionCheckError,
} from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import { sendEmailMessage, type ChannelSender } from '@sonar/db/email';
import {
  withSocialSessionCheck,
  reconcileSocialSessionKeepalive,
} from '@sonar/db/social-accounts';
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
export { timeout as socialPageTimeout };
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
          {
            ...resolveSocialSession(sessionAccount),
            persistStorageState: account.persistStorageState,
            persistDevice: account.persistDevice,
            persistFailureShot: account.persistFailureShot,
          },
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
export async function runSocialSessionCheck(
  input: { accountId: string },
  taskId?: string,
) {
  return withSocialSessionCheck(
    input.accountId,
    async (account, session) => {
      try {
        await socialSendBrowser.check(
          account,
          session ?? resolveSocialSession(account),
          await timeout(),
        );
        return { valid: true };
      } catch (error) {
        return {
          valid: false,
          ...(error instanceof SocialProfileBusyError ? { busy: true } : {}),
          reason: socialSessionCheckReason(error),
          ...(error instanceof SocialSessionCheckError && error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
        };
      }
    },
    new Date(),
    'check',
    taskId,
  );
}
export async function runSocialSessionKeepalive(
  input: { accountId: string },
  taskId?: string,
) {
  return withSocialSessionCheck(
    input.accountId,
    async (account, session) => {
      try {
        const {
          rows: [setting],
        } = await sonarPool.query(
          "select value from settings where key='social.keepalive.pause_ms'",
        );
        const pauseMs = Number(setting?.value);
        if (!Number.isSafeInteger(pauseMs) || pauseMs < 0 || pauseMs > 30000)
          throw new SocialSessionCheckError('browser');
        await socialSendBrowser.keepalive(
          account,
          session,
          await timeout(),
          pauseMs,
        );
        return { valid: true };
      } catch (error) {
        return {
          valid: false,
          ...(error instanceof SocialProfileBusyError ? { busy: true } : {}),
          reason: socialSessionCheckReason(error),
        };
      }
    },
    new Date(),
    'keepalive',
    taskId,
  );
}
export async function registerSocialSessionTasks() {
  await boss.createQueue('social.session.check');
  await boss.createQueue('social.session.keepalive');
  await runTask(
    'social.session.keepalive',
    (payload, taskId) =>
      runSocialSessionKeepalive(payload as { accountId: string }, taskId),
    async () => {
      await reconcileSocialSessionKeepalive();
    },
  );
  await boss.createQueue('social.session.keepalive.reconcile');
  await boss.work('social.session.keepalive.reconcile', async () => {
    await reconcileSocialSessionKeepalive();
  });
  await boss.schedule('social.session.keepalive.reconcile', '* * * * *');
  await reconcileSocialSessionKeepalive();
  await runTask('social.session.check', (payload, taskId) =>
    runSocialSessionCheck(payload as { accountId: string }, taskId),
  );
}
export const closeSocialSendBrowser = () => socialSendBrowser.close();
