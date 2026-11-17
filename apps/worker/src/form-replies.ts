import {
  deterministicFormReplyMatchEvidence,
  parseFormReplyMatch,
  createOpenRouterClient,
  BudgetExceeded,
  OpenRouterError,
  PaidHttpError,
  type TextModel,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import {
  withFormReplyMatchLock,
  getFormReplyContext,
  getReplyMatchCompanies,
  getFormReplyCandidates,
  bindFormReplyConversation,
  suggestFormReplyMatch,
} from '@sonar/db/form-replies';
import {
  runBudgetedRequest,
  BillingUncertain,
  paidErrorReason,
} from '@sonar/db/budget';
import { boss, runTask, TaskFailure, type TaskOutcome } from '@sonar/db/tasks';
const skip = (reasonCode: string, reasonUk: string): TaskOutcome => ({
  status: 'skipped',
  reasonCode,
  reasonUk,
});

export async function matchFormReply(
  input: { conversationId: string; messageId: string; senderPhone?: string },
  taskId: string,
  client?: ReturnType<typeof createOpenRouterClient>,
): Promise<TaskOutcome> {
  return withFormReplyMatchLock(input.conversationId, () =>
    runMatchFormReply(input, taskId, client),
  );
}
async function runMatchFormReply(
  input: { conversationId: string; messageId: string; senderPhone?: string },
  taskId: string,
  client?: ReturnType<typeof createOpenRouterClient>,
): Promise<TaskOutcome> {
  const context = await getFormReplyContext(
    input.conversationId,
    input.messageId,
  );
  if (!context)
    return skip('message_missing', 'Вхідне повідомлення не знайдено.');
  if (context.companyId || context.match?.suppressed)
    return skip(
      'reply_match_resolved',
      'Діалог уже прив’язано або автоматичну прив’язку відхилено.',
    );
  if (context.match?.taskId === taskId)
    return { status: 'done', result: { match: context.match } };
  const evidence = deterministicFormReplyMatchEvidence(
    context.channel,
    [context.sender, input.senderPhone].filter((v): v is string => !!v),
    await getReplyMatchCompanies(),
  );
  if (evidence) {
    const companyId = evidence.companyId;
    const bound = await bindFormReplyConversation({
      conversationId: context.id,
      companyId,
      method: 'automatic',
      confidence: 1,
      reasonUk:
        evidence.kind === 'email_domain'
          ? `Домен ${evidence.value} адреси відправника однозначно збігається з доменом сайту або email компанії.`
          : evidence.kind === 'telegram_username'
            ? `Ім’я Telegram @${evidence.value} однозначно збігається з контактом компанії.`
            : `Номер ${evidence.value} у міжнародному форматі однозначно збігається з телефоном компанії.`,
      taskId,
    });
    return {
      status: 'done',
      result: { companyId, bound, method: 'automatic' },
    };
  }
  if (!client && !process.env.OPENROUTER_API_KEY)
    return skip(
      'reply_match_key_missing',
      'Додайте ключ OpenRouter для зіставлення невідомих відповідей за допомогою ШІ.',
    );
  const { rows } = await sonarPool.query(
    "select key,value from settings where key like 'forms.match_%' or key in ('ai.models','ai.model.cheap')",
  );
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const integer = (key: string, max: number) => {
    const value = config[key];
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new TaskFailure(
        'reply_match_config_invalid',
        'Перевірте налаштування зіставлення відповідей на форми.',
      );
    return Number(value);
  };
  const days = integer('forms.match_window_days', 365),
    limit = integer('forms.match_candidate_limit', 1000),
    chars = integer('forms.match_message_chars', 20000),
    maxTokens = integer('forms.match_max_tokens', 10000);
  const threshold = config['forms.match_auto_threshold'],
    maxUsd = config['forms.match_max_usd'];
  if (
    typeof threshold !== 'number' ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isFinite(threshold) ||
    typeof maxUsd !== 'number' ||
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0 ||
    typeof config['forms.match_prompt'] !== 'string'
  )
    throw new TaskFailure(
      'reply_match_config_invalid',
      'Перевірте налаштування зіставлення відповідей на форми.',
    );
  const candidates = await getFormReplyCandidates(
    context.channel,
    days,
    limit,
    chars,
  );
  if (!candidates.length)
    return skip(
      'reply_match_no_candidates',
      'Немає нещодавно надісланих форм зі спільним каналом відповіді.',
    );
  const model = (config['ai.models'] as TextModel[] | undefined)?.find(
    (m) => m.id === config['ai.model.cheap'],
  );
  if (!model)
    return {
      status: 'paused',
      reasonCode: 'model_missing',
      reasonUk: 'Виберіть дешеву модель у налаштуваннях ШІ.',
    };
  const messages = [
    {
      role: 'system' as const,
      content: config['forms.match_prompt'] as string,
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        untrusted_data: {
          channel: context.channel,
          sender: context.sender,
          message: `${context.subject ?? ''}\n${context.body}`.slice(0, chars),
          candidates: candidates.map((c) => ({
            companyId: c.companyId,
            name: c.name,
            city: c.city,
            website: c.website,
            message: c.message,
          })),
        },
      }),
    },
  ];
  const estimate =
    (Buffer.byteLength(JSON.stringify(messages)) + 100) * model.promptUsd +
    maxTokens * model.completionUsd +
    model.requestUsd;
  if (!Number.isFinite(estimate) || estimate < 0 || estimate > maxUsd)
    return {
      status: 'paused',
      reasonCode: 'reply_match_price_cap',
      reasonUk:
        'Оцінка вартості перевищує ліміт зіставлення відповіді. Зменште список кандидатів або виберіть дешевшу модель.',
    };
  client ??= createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  try {
    const response = await runBudgetedRequest(
      'openrouter',
      estimate,
      taskId,
      () => client.complete(model.id, messages, maxTokens),
    );
    let match;
    try {
      match = parseFormReplyMatch(
        response.text,
        candidates.map((c) => c.companyId),
      );
    } catch {
      throw new TaskFailure(
        'reply_match_invalid',
        'ШІ повернув некоректний результат зіставлення відповіді.',
      );
    }
    if (!match.companyId)
      return { status: 'done', result: { match, costUsd: response.costUsd } };
    const candidate = candidates.find((c) => c.companyId === match.companyId)!;
    const bound = match.confidence >= threshold;
    const applied = bound
      ? await bindFormReplyConversation({
          conversationId: context.id,
          companyId: match.companyId,
          method: 'ai',
          confidence: match.confidence,
          reasonUk: match.reasonUk,
          formMessageId: candidate.formMessageId,
          taskId,
        })
      : await suggestFormReplyMatch({
          conversationId: context.id,
          companyId: match.companyId,
          confidence: match.confidence,
          reasonUk: match.reasonUk,
          formMessageId: candidate.formMessageId,
          taskId,
        });
    return {
      status: 'done',
      result: {
        match,
        bound: bound && applied,
        applied,
        costUsd: response.costUsd,
      },
    };
  } catch (error) {
    if (error instanceof TaskFailure) throw error;
    if (error instanceof BudgetExceeded || error instanceof BillingUncertain)
      return {
        status: 'paused',
        reasonCode:
          error instanceof BudgetExceeded
            ? 'budget_exceeded'
            : 'billing_uncertain',
        reasonUk: error.message,
      };
    if (error instanceof PaidHttpError)
      throw new TaskFailure(
        `http_${error.status}`,
        paidErrorReason(error.status, 'OpenRouter'),
      );
    if (error instanceof OpenRouterError)
      throw new TaskFailure(
        error.code,
        'Не вдалося отримати коректний результат OpenRouter. Перевірте витрати перед повтором.',
      );
    throw error;
  }
}
export async function registerFormReplyTasks() {
  await boss.createQueue('form.reply.match');
  await runTask('form.reply.match', (payload, id) =>
    matchFormReply(
      payload as {
        conversationId: string;
        messageId: string;
        senderPhone?: string;
      },
      id,
    ),
  );
}
