import { telegramAdapter, decryptTelegramSession } from '@sonar/core/telegram';
import { sendEmailMessage, type ChannelSender } from '@sonar/db/email';
import type { TaskOutcome } from '@sonar/db/tasks';

export async function runTelegramSend(
  input: { messageId: string },
  taskId: string,
  send?: ChannelSender,
  now?: Date,
): Promise<TaskOutcome> {
  if (!send && (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH))
    return {
      status: 'paused',
      reasonCode: 'telegram_keys_missing',
      reasonUk: 'Додайте TELEGRAM_API_ID і TELEGRAM_API_HASH на сервері',
    };
  return sendEmailMessage(
    input.messageId,
    taskId,
    send ??
      ((request, account) =>
        telegramAdapter.send({
          accountId: account!.id,
          session: decryptTelegramSession(
            String(account!.settings.sessionEncrypted),
            process.env.AUTH_SECRET!,
          ),
          to: request.to,
          body: request.body,
          idempotencyKey: request.idempotencyKey,
        })),
    now,
    Math.random,
    'telegram',
  );
}
export const closeTelegramClients = () => telegramAdapter.closeAll();
