import {
  BudgetExceeded,
  OpenRouterError,
  PaidHttpError,
  createOpenRouterClient,
  parseOutreachDraft,
  type TextModel,
} from '@sonar/core';
import { draftSnapshot, saveOutreachDraft } from '@sonar/db/outreach';
import {
  BillingUncertain,
  paidErrorReason,
  runBudgetedRequest,
} from '@sonar/db/budget';
import { boss, runTask, TaskFailure, type TaskOutcome } from '@sonar/db/tasks';

type Input = {
  companyId: string;
  campaignId: string;
  analysisId: string;
  contactId: string;
  version: string;
};
export async function runOutreachDraft(
  input: Input,
  taskId: string,
  client?: ReturnType<typeof createOpenRouterClient>,
): Promise<TaskOutcome> {
  const data = await draftSnapshot(input, taskId);
  if (!data)
    return {
      status: 'skipped',
      reasonCode: 'draft_unavailable',
      reasonUk: 'Контакт, аналіз або участь компанії у кампанії недоступні.',
    };
  if (data.existingMessageId)
    return { status: 'done', result: { messageId: data.existingMessageId } };
  const config = data.config;
  const maxUsd = Number(config['draft.max_usd']),
    maxTokens = Number(config['draft.max_tokens']),
    shortMaxLength = Number(config['draft.short_max_length']);
  if (
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0 ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 10000 ||
    !Number.isInteger(shortMaxLength) ||
    shortMaxLength < 1 ||
    shortMaxLength > 10000 ||
    typeof config['draft.prompt'] !== 'string' ||
    !config['draft.prompt'].trim() ||
    typeof data.analysis?.language !== 'string' ||
    !/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(data.analysis.language)
  )
    throw new TaskFailure(
      'draft_config_invalid',
      'Перевірте налаштування чернеток та мову аналізу компанії.',
    );
  const model = (config['ai.models'] as TextModel[] | undefined)?.find(
    (m) => m.id === config['ai.model.cheap'],
  );
  if (!model || (!client && !process.env.OPENROUTER_API_KEY))
    return {
      status: 'paused',
      reasonCode: 'draft_model_missing',
      reasonUk: 'Додайте ключ OpenRouter та виберіть дешеву модель.',
    };
  const { config: _config, ...untrusted } = data;
  void _config;
  const messages = [
    { role: 'system' as const, content: config['draft.prompt'] },
    {
      role: 'user' as const,
      content: JSON.stringify({
        untrusted_data: untrusted,
        requested_output: {
          channel: data.channel,
          language: data.analysis.language,
          short_max_length: shortMaxLength,
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
      reasonCode: 'draft_price_limit',
      reasonUk:
        'Оцінена вартість чернетки перевищує ліміт. Виберіть дешевшу модель або змініть ліміт.',
    };
  try {
    const api =
      client ?? createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
    const response = await runBudgetedRequest(
      'openrouter',
      estimate,
      taskId,
      () => api.complete(model.id, messages, maxTokens),
    );
    let draft;
    try {
      draft = parseOutreachDraft(response.text, data.channel, shortMaxLength);
    } catch {
      throw new TaskFailure(
        'draft_schema_invalid',
        'ІІ повернув некоректну чернетку. Витрати збережено; повтор використовує ту саму відповідь.',
      );
    }
    const saved = await saveOutreachDraft(input, draft, taskId);
    return { status: 'done', result: { messageId: saved.id } };
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
    if (error instanceof OpenRouterError) {
      if (error.code === 'network_unavailable')
        return {
          status: 'paused',
          reasonCode: 'billing_uncertain',
          reasonUk:
            'З’єднання з OpenRouter перервано. Звірте витрати перед повтором.',
        };
      throw new TaskFailure(
        error.code,
        error.finishReason === 'length'
          ? 'Відповідь ІІ обрізана: збільште draft.max_tokens. Витрати збережено.'
          : `OpenRouter не повернув коректну чернетку (${error.code}). Витрати збережено.`,
      );
    }
    throw error;
  }
}
export async function registerDraftTasks() {
  await boss.createQueue('ai.drafts');
  await runTask('ai.drafts', (payload, taskId) =>
    runOutreachDraft(payload as Input, taskId),
  );
}
