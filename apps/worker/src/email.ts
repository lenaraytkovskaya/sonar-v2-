import { sendResendEmail } from '@sonar/core';
import { sendEmailMessage, type EmailSender } from '@sonar/db/email';
import { boss, runTask, type TaskOutcome } from '@sonar/db/tasks';
export async function runEmailSend(
  input: { messageId: string },
  taskId: string,
  send?: EmailSender,
  now?: Date,
): Promise<TaskOutcome> {
  if (!send && !process.env.RESEND_API_TOKEN)
    return {
      status: 'paused',
      reasonCode: 'resend_key_missing',
      reasonUk: 'Додайте ключ Resend перед надсиланням email.',
    };
  return sendEmailMessage(
    input.messageId,
    taskId,
    send ??
      ((request) => sendResendEmail(request, process.env.RESEND_API_TOKEN!)),
    now,
  );
}
export async function registerEmailTasks() {
  await boss.createQueue('message.send');
  await runTask('message.send', (payload, id) =>
    runEmailSend(payload as { messageId: string }, id),
  );
}
