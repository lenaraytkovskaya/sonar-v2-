import {
  BudgetExceeded,
  PaidHttpError,
  OpenRouterError,
  parseCampaignSuggestion,
  parseCompanyFilters,
  createOpenRouterClient,
  type TextModel,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import {
  BillingUncertain,
  runBudgetedRequest,
  paidErrorReason,
} from '@sonar/db/budget';
import { boss, runTask, TaskFailure, type TaskOutcome } from '@sonar/db/tasks';
type Input = {
  action: string;
  text: string;
  instruction?: string;
  context?: string;
};
export async function runAiAssist(
  input: Input,
  id: string,
  client?: ReturnType<typeof createOpenRouterClient>,
): Promise<TaskOutcome> {
  if (!client && !process.env.OPENROUTER_API_KEY)
    return {
      status: 'paused',
      reasonCode: 'api_key_missing',
      reasonUk: 'Додайте ключ OpenRouter, щоб скористатися ІІ-помічником.',
    };
  client ??= createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const { rows } = await sonarPool.query(
    "select key,value from settings where key like 'ai.%' or key='company.about'",
  );
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const model = (config['ai.models'] as TextModel[] | undefined)?.find(
    (m) => m.id === config['ai.model.cheap'],
  );
  if (!model)
    return {
      status: 'paused',
      reasonCode: 'model_missing',
      reasonUk: 'Виберіть дешеву модель у налаштуваннях ІІ.',
    };
  const instruction = config['ai.actions']?.[input.action];
  if (typeof instruction !== 'string')
    throw new TaskFailure('action_invalid', 'Невідома дія ІІ-помічника.');
  const messages = [
    { role: 'system' as const, content: String(config['ai.system_prompt']) },
    {
      role: 'user' as const,
      content: `${instruction} ${input.instruction ?? ''}\nContext: ${input.context ?? config['company.about'] ?? ''}\nText: ${input.text}`,
    },
  ];
  const maxTokens = Number(config['ai.max_tokens']);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 10000)
    throw new TaskFailure('ai_config_invalid', 'Перевірте налаштування ІІ.');
  const estimate =
    (Buffer.byteLength(JSON.stringify(messages)) + 100) * model.promptUsd +
    maxTokens * model.completionUsd +
    model.requestUsd;
  try {
    const response = await runBudgetedRequest('openrouter', estimate, id, () =>
      client.complete(model.id, messages, maxTokens),
    );
    if (input.action === 'company_filters') {
      try {
        return {
          status: 'done',
          result: {
            filters: parseCompanyFilters(response.text),
            costUsd: response.costUsd,
          },
        };
      } catch {
        throw new TaskFailure(
          'ai_schema_invalid',
          'ІІ повернув некоректні фільтри. Спробуйте уточнити запит.',
        );
      }
    }
    if (input.action === 'campaign') {
      try {
        return {
          status: 'done',
          result: {
            suggestion: parseCampaignSuggestion(response.text),
            costUsd: response.costUsd,
          },
        };
      } catch {
        throw new TaskFailure(
          'ai_schema_invalid',
          'ІІ повернув некоректні налаштування кампанії. Спробуйте уточнити опис.',
        );
      }
    }
    return {
      status: 'done',
      result: { text: response.text, costUsd: response.costUsd },
    };
  } catch (error) {
    if (error instanceof TaskFailure) throw error;
    if (error instanceof PaidHttpError)
      throw new TaskFailure(
        `http_${error.status}`,
        paidErrorReason(error.status, 'OpenRouter'),
      );
    if (error instanceof BudgetExceeded || error instanceof BillingUncertain)
      return {
        status: 'paused',
        reasonCode:
          error instanceof BudgetExceeded
            ? 'budget_exceeded'
            : 'billing_uncertain',
        reasonUk: error.message,
      };
    throw new TaskFailure(
      'ai_request_failed',
      'Не вдалося завершити запит ІІ. Перевірте ключ і витрати OpenRouter перед повтором.',
    );
  }
}
export async function registerAiTasks() {
  await boss.createQueue('ai.models');
  await boss.createQueue('ai.assist');
  await runTask('ai.models', async () => {
    try {
      const models = await createOpenRouterClient(
        process.env.OPENROUTER_API_KEY ?? '',
      ).models();
      await sonarPool.query(
        "insert into settings(key,value) values('ai.models',$1) on conflict(key) do update set value=excluded.value,updated_at=now()",
        [JSON.stringify(models)],
      );
      return { status: 'done', result: { count: models.length } };
    } catch (error) {
      throw new TaskFailure(
        error instanceof PaidHttpError
          ? `http_${error.status}`
          : error instanceof OpenRouterError
            ? error.code
            : 'models_unavailable',
        'Не вдалося завантажити моделі. Перевірте ключ OpenRouter.',
      );
    }
  });
  await runTask('ai.assist', (payload, id) =>
    runAiAssist(payload as Input, id),
  );
}
