import { socialTarget, type SocialTarget } from '@sonar/core';
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
          account.facebookDraft,
          taskId,
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
    'recipient',
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

export async function runFacebookRecipientCheck(
  input: { accountId: string; target: SocialTarget },
  taskId: string,
  now = new Date(),
): Promise<TaskOutcome> {
  const target = socialTarget(input.target?.canonicalUrl);
  if (!target || target.network !== 'facebook' || target.kind === 'unsupported')
    return {
      status: 'skipped',
      reasonCode: 'facebook_recipient_invalid',
      reasonUk:
        'Перевірка доступна лише для Facebook-профілю. Перевірте контакт.',
    };
  const { rows } = await sonarPool.query(
    'select channel,status,settings from channel_accounts where id=$1',
    [input.accountId],
  );
  if (!rows[0] || rows[0].channel !== 'facebook')
    return {
      status: 'skipped',
      reasonCode: 'facebook_account_missing',
      reasonUk:
        'Facebook-акаунт не знайдено. Перевірте власний акаунт у «Канали».',
    };
  if (
    rows[0].status !== 'active' ||
    rows[0].settings.enabled === false ||
    rows[0].settings.sessionStatus !== 'valid'
  )
    return {
      status: 'paused',
      reasonCode: 'facebook_account_unavailable',
      reasonUk:
        'Facebook-акаунт не готовий. Потрібна дія: перевірте вхід у «Канали».',
    };
  return withSocialSessionCheck(
    input.accountId,
    async (account, session) => {
      try {
        const result = await socialSendBrowser.checkRecipient(
          { ...account, channel: 'facebook' },
          session,
          target,
          await timeout(),
          taskId,
        );
        if (result.valid)
          return {
            valid: true,
            result: { ...result.observation, accountId: input.accountId },
          };
        return {
          valid: false,
          reason: result.reason,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
          result: { ...result.observation, accountId: input.accountId },
        };
      } catch (error) {
        const reason = socialSessionCheckReason(error);
        const checkpointVisible = reason === 'checkpoint';
        const loginVisible = reason === 'login_required';
        const diagnostic =
          error instanceof SocialSessionCheckError
            ? error.diagnostic
            : undefined;
        return {
          valid: false,
          reason,
          ...(error instanceof SocialProfileBusyError ? { busy: true } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          result: {
            accountId: input.accountId,
            profileUrlMatches: false,
            headingFound: false,
            messageButtonCount: 0,
            messageButtonCaption: null,
            messageButtonRole: null,
            extraWindowCount: 0,
            hasNewMessageWindow: false,
            hasMiniChat: false,
            loginVisible,
            identityCheckVisible: checkpointVisible,
            checkpointVisible,
            language: diagnostic?.page?.lang ?? 'missing',
            elapsedMs: 0,
            summaryUk:
              checkpointVisible || loginVisible
                ? 'Facebook просить підтвердити вхід. Відкрийте браузер і підтвердьте.'
                : 'Не вдалося перевірити профіль. Потрібна дія: відкрийте «Канали» та перевірте стан акаунта.',
          },
        };
      }
    },
    now,
    'check',
    taskId,
  );
}

export async function registerSocialSessionTasks() {
  await boss.createQueue('social.session.check');
  await boss.createQueue('social.session.keepalive');
  await boss.createQueue('social.recipient.check');
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
  await runTask('social.recipient.check', (payload, taskId) =>
    runFacebookRecipientCheck(
      payload as { accountId: string; target: SocialTarget },
      taskId,
    ),
  );
}
export const closeSocialSendBrowser = () => socialSendBrowser.close();
