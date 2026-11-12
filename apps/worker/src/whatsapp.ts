import type { CountryCode } from '@sonar/core';
import { whatsappAdapter } from '@sonar/core/whatsapp';
import { sendEmailMessage, type ChannelSender } from '@sonar/db/email';
import type { TaskOutcome } from '@sonar/db/tasks';

export async function runWhatsAppSend(
  input: { messageId: string },
  taskId: string,
  send?: ChannelSender,
  now?: Date,
): Promise<TaskOutcome> {
  if (!send && !process.env.WAHA_API_KEY)
    return {
      status: 'paused',
      reasonCode: 'whatsapp_keys_missing',
      reasonUk: 'Додайте WAHA_API_KEY на сервері.',
    };
  return sendEmailMessage(
    input.messageId,
    taskId,
    send ??
      (async (request, account) => {
        const result = await whatsappAdapter.send({
          accountId: account!.id,
          to: request.to,
          body: request.body,
          idempotencyKey: request.idempotencyKey,
          defaultCountry: account!.settings.countryCode as CountryCode,
        });
        return result.messageId;
      }),
    now,
    Math.random,
    'whatsapp',
  );
}
