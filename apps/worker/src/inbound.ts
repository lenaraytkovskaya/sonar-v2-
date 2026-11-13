import {
  receivedEmailContent,
  parseInboundCategory,
  parseReplyDraft,
} from '@sonar/core';
import {
  telegramAdapter,
  decryptTelegramSession,
  type TelegramIncoming,
} from '@sonar/core/telegram';
import { sonarPool } from '@sonar/db';
import { whatsappAdapter } from '@sonar/core/whatsapp';
import {
  recordInbound,
  getInboundMessage,
  getConversationHistory,
  applyInboundClassification,
  saveReplyDraft,
} from '@sonar/db/inbound';
import {
  boss,
  enqueueTask,
  runTask,
  TaskFailure,
  type TaskOutcome,
} from '@sonar/db/tasks';
import { runAiAssist } from './ai.js';

type EmailInput = {
  emailId: string;
  eventId: string;
  receivedAt: string;
  recipients: string[];
};
type WhatsAppInput = {
  session: string;
  id: string;
  from: string;
  body: string;
  timestamp: number;
};
export async function receiveEmail(
  input: EmailInput,
  network: typeof fetch = fetch,
): Promise<TaskOutcome> {
  if (!process.env.RESEND_API_TOKEN)
    return {
      status: 'paused',
      reasonCode: 'resend_key_missing',
      reasonUk: 'Додайте ключ Resend для отримання вхідних листів.',
    };
  let response: Response;
  try {
    response = await network(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(input.emailId)}`,
      {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_TOKEN}` },
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new TaskFailure(
      'resend_unavailable',
      'Не вдалося завантажити вхідний лист із Resend. Повторіть спробу.',
    );
  }
  if (!response.ok)
    throw new TaskFailure(
      `resend_${response.status}`,
      'Resend не повернув вхідний лист. Перевірте ключ доступу та повторіть.',
    );
  let email: ReturnType<typeof receivedEmailContent>;
  try {
    email = receivedEmailContent(await response.json());
  } catch {
    throw new TaskFailure(
      'resend_response_invalid',
      'Resend повернув некоректний вхідний лист.',
    );
  }
  const {
    rows: [account],
  } = await sonarPool.query(
    "select id from channel_accounts where channel='email' and lower(address)=any($1::text[]) order by id limit 1",
    [email.recipients.map((value) => value.toLowerCase())],
  );
  if (!account)
    return {
      status: 'skipped',
      reasonCode: 'email_account_missing',
      reasonUk: 'Для адресата вхідного листа не знайдено email-акаунт.',
    };
  const { recipients: _recipients, ...content } = email;
  void _recipients;
  const result = await recordInbound({
    ...content,
    channel: 'email',
    accountId: account.id,
    providerId: input.emailId,
    receivedAt: new Date(input.receivedAt),
  });
  return { status: 'done', result };
}
export async function receiveWhatsApp(
  input: WhatsAppInput,
  adapter: Pick<typeof whatsappAdapter, 'phoneByLid'> = whatsappAdapter,
): Promise<TaskOutcome> {
  if (input.session !== 'default' || !/^[1-9]\d*@(c\.us|lid)$/.test(input.from))
    return {
      status: 'skipped',
      reasonCode: 'whatsapp_non_private',
      reasonUk: 'Подія WhatsApp не є особистим текстовим повідомленням.',
    };
  const {
    rows: [account],
  } = await sonarPool.query(
    "select id from channel_accounts where channel='whatsapp' and settings->>'session'=$1 order by id limit 1",
    [input.session],
  );
  if (!account)
    return {
      status: 'skipped',
      reasonCode: 'whatsapp_account_missing',
      reasonUk: 'Акаунт WhatsApp не знайдено.',
    };
  const lid = input.from.endsWith('@lid');
  let senderPhone: string | undefined;
  let phoneLookupFailed = false;
  if (lid) {
    try {
      senderPhone = (await adapter.phoneByLid(input.from)) ?? undefined;
    } catch {
      phoneLookupFailed = true;
    }
  }
  const result = await recordInbound({
    channel: 'whatsapp',
    accountId: account.id,
    providerId: input.id,
    sender: lid
      ? `whatsapp:lid:${input.from.split('@')[0]}`
      : `+${input.from.split('@')[0]}`,
    senderPhone,
    body: await incomingBody(input.body),
    receivedAt: new Date(input.timestamp * 1000),
  });
  return {
    status: 'done',
    result: { ...result, ...(phoneLookupFailed ? { phoneLookupFailed } : {}) },
  };
}
export async function receiveTelegram(
  input: TelegramIncoming & { accountId: string },
): Promise<TaskOutcome> {
  return {
    status: 'done',
    result: await recordInbound({
      ...input,
      channel: 'telegram',
      body: await incomingBody(input.body),
      receivedAt: new Date(input.receivedAt),
    }),
  };
}
async function incomingBody(body: string) {
  if (body.trim()) return body;
  const {
    rows: [setting],
  } = await sonarPool.query(
    "select value from settings where key='inbound.empty_message_placeholder'",
  );
  if (typeof setting?.value !== 'string' || !setting.value.trim())
    throw new TaskFailure(
      'inbound_placeholder_missing',
      'Налаштуйте опис вхідного повідомлення без тексту.',
    );
  return setting.value;
}
export async function syncTelegramListeners(
  adapter = telegramAdapter,
): Promise<TaskOutcome> {
  const { rows } = await sonarPool.query(
    "select id,settings from channel_accounts where channel='telegram' and status='active' and settings->>'sessionEncrypted' is not null",
  );
  const active = new Set(rows.map((account) => account.id));
  await Promise.all(
    adapter
      .listeningAccounts()
      .filter((id) => !active.has(id))
      .map((id) => adapter.close(id)),
  );
  if (
    !process.env.AUTH_SECRET ||
    !process.env.TELEGRAM_API_ID ||
    !process.env.TELEGRAM_API_HASH
  )
    return {
      status: 'paused',
      reasonCode: 'telegram_keys_missing',
      reasonUk:
        'Додайте ключі Telegram і AUTH_SECRET для отримання повідомлень.',
    };
  const failures: string[] = [];
  for (const account of rows) {
    try {
      await adapter.listen(
        account.id,
        decryptTelegramSession(
          account.settings.sessionEncrypted,
          process.env.AUTH_SECRET,
        ),
        async (message) => {
          await enqueueTask(
            'telegram.receive',
            `telegram.receive:${account.id}:${message.providerId}`,
            { accountId: account.id, ...message },
          );
        },
      );
    } catch {
      failures.push(account.id);
    }
  }
  if (failures.length)
    throw new TaskFailure(
      'telegram_listener_failed',
      `Не вдалося підключити отримання Telegram для ${failures.length} акаунтів. Перевірте сесії та повторіть.`,
    );
  return { status: 'done', result: { accounts: rows.length } };
}
export async function classifyInbound(
  input: { messageId: string },
  taskId: string,
  assist = runAiAssist,
): Promise<TaskOutcome> {
  const message = await getInboundMessage(input.messageId);
  if (!message)
    return {
      status: 'skipped',
      reasonCode: 'message_missing',
      reasonUk: 'Вхідне повідомлення не знайдено.',
    };
  const outcome = await assist(
    { action: 'inbound', text: JSON.stringify({ untrusted_message: message }) },
    taskId,
  );
  if (outcome.status !== 'done') return outcome;
  let category;
  try {
    category = parseInboundCategory(
      String((outcome.result as { text?: unknown } | undefined)?.text),
    );
  } catch {
    throw new TaskFailure(
      'inbound_category_invalid',
      'ШІ повернув некоректну категорію вхідного повідомлення.',
    );
  }
  await applyInboundClassification(input.messageId, category);
  return { status: 'done', result: { ...outcome.result, category } };
}
export async function draftReply(
  input: { conversationId: string },
  taskId: string,
  assist = runAiAssist,
): Promise<TaskOutcome> {
  const history = await getConversationHistory(input.conversationId);
  if (!history.conversation || history.blocked)
    return {
      status: 'skipped',
      reasonCode: 'reply_unavailable',
      reasonUk: 'Діалог недоступний або компанія відмовилася від контакту.',
    };
  const outcome = await assist(
    {
      action: 'reply',
      text: JSON.stringify({
        untrusted_conversation: {
          channel: history.conversation.channel,
          company: history.company
            ? {
                name: history.company.name,
                website: history.company.website,
                countryCode: history.company.countryCode,
              }
            : null,
          campaign: history.campaign
            ? {
                name: history.campaign.name,
                offer: history.campaign.offer,
                outreachGoal: history.campaign.outreachGoal,
                languageCode: history.campaign.languageCode,
              }
            : null,
          messages: history.messages.map((message) => ({
            direction: message.direction,
            body: message.body,
            subject: message.subject,
            createdAt: message.createdAt,
            classification: (
              message as typeof message & { classification?: string | null }
            ).classification,
          })),
        },
      }),
    },
    taskId,
  );
  if (outcome.status !== 'done') return outcome;
  let content;
  try {
    content = parseReplyDraft(
      String((outcome.result as { text?: unknown } | undefined)?.text),
    );
  } catch {
    throw new TaskFailure(
      'reply_invalid',
      'ШІ повернув некоректну чернетку відповіді.',
    );
  }
  const draft = await saveReplyDraft(input.conversationId, content, taskId);
  return { status: 'done', result: { ...outcome.result, messageId: draft.id } };
}
export async function registerInboundTasks() {
  for (const name of [
    'email.receive',
    'whatsapp.receive',
    'telegram.receive',
    'telegram.sync',
    'ai.inbound',
    'ai.reply',
    'sonar.telegram.schedule',
  ])
    await boss.createQueue(name);
  await runTask('email.receive', (payload) =>
    receiveEmail(payload as EmailInput),
  );
  await runTask('whatsapp.receive', (payload) =>
    receiveWhatsApp(payload as WhatsAppInput),
  );
  await runTask('telegram.receive', (payload) =>
    receiveTelegram(payload as TelegramIncoming & { accountId: string }),
  );
  await runTask('telegram.sync', () => syncTelegramListeners());
  await runTask('ai.inbound', (payload, id) =>
    classifyInbound(payload as { messageId: string }, id),
  );
  await runTask('ai.reply', (payload, id) =>
    draftReply(payload as { conversationId: string }, id),
  );
  const sync = () =>
    enqueueTask(
      'telegram.sync',
      `telegram.sync:${new Date().toISOString().slice(0, 16)}`,
    );
  await boss.work('sonar.telegram.schedule', async () => {
    await sync();
  });
  await boss.schedule('sonar.telegram.schedule', '* * * * *');
  await sync();
}
