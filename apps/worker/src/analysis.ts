import {
  BudgetExceeded,
  OpenRouterError,
  PaidHttpError,
  createOpenRouterClient,
  parseAnalysis,
  type TextModel,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { analysisSnapshot } from '@sonar/db/analysis';
import {
  BillingUncertain,
  runBudgetedRequest,
  paidErrorReason,
} from '@sonar/db/budget';
import { boss, runTask, TaskFailure, type TaskOutcome } from '@sonar/db/tasks';

type Input = { companyId: string; campaignId: string; version: string };
export async function runCompanyAnalysis(
  input: Input,
  taskId: string,
  client?: ReturnType<typeof createOpenRouterClient>,
): Promise<TaskOutcome> {
  const {
    rows: [existing],
  } = await sonarPool.query(
    'select id,result,cost_usd from analyses where company_id=$1 and campaign_id=$2 and version=$3',
    [input.companyId, input.campaignId, input.version],
  );
  if (existing)
    return {
      status: 'done',
      result: {
        analysisId: existing.id,
        ...existing.result,
        costUsd: Number(existing.cost_usd),
      },
    };
  const data = await analysisSnapshot(
    input.companyId,
    input.campaignId,
    taskId,
  );
  if (!data)
    return {
      status: 'skipped',
      reasonCode: 'company_missing',
      reasonUk: 'Компанію або її участь у кампанії не знайдено.',
    };
  const config = data.config;
  const minScore = Number(config['analysis.min_score']),
    maxUsd = Number(config['analysis.max_usd']),
    maxTokens = Number(config['analysis.max_tokens']);
  if (
    !Number.isFinite(minScore) ||
    minScore < 0 ||
    minScore > 100 ||
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0 ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 10000 ||
    typeof config['analysis.prompt'] !== 'string'
  )
    throw new TaskFailure(
      'analysis_config_invalid',
      'Перевірте налаштування ІІ-аналізу.',
    );
  if (data.score === null || data.score < minScore)
    return {
      status: 'skipped',
      reasonCode: 'score_below_threshold',
      reasonUk: 'Скоринг нижчий за поріг',
    };
  const model = (config['ai.models'] as TextModel[] | undefined)?.find(
    (m) => m.id === config['ai.model.cheap'],
  );
  if (!model || (!client && !process.env.OPENROUTER_API_KEY))
    return {
      status: 'paused',
      reasonCode: 'analysis_model_missing',
      reasonUk: 'Додайте ключ OpenRouter та виберіть дешеву модель.',
    };
  const { config: _config, ...untrusted } = data;
  void _config;
  const messages = [
    { role: 'system' as const, content: config['analysis.prompt'] },
    {
      role: 'user' as const,
      content: JSON.stringify({ untrusted_data: untrusted }),
    },
  ];
  const estimate =
    (Buffer.byteLength(JSON.stringify(messages)) + 100) * model.promptUsd +
    maxTokens * model.completionUsd +
    model.requestUsd;
  if (!Number.isFinite(estimate) || estimate < 0 || estimate > maxUsd)
    return {
      status: 'paused',
      reasonCode: 'analysis_price_limit',
      reasonUk:
        'Оцінена вартість аналізу перевищує ліміт. Виберіть дешевшу модель або змініть ліміт.',
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
    let result;
    try {
      result = parseAnalysis(response.text, data.contacts, data.about);
    } catch {
      throw new TaskFailure(
        'analysis_schema_invalid',
        'ІІ повернув некоректний аналіз. Витрати збережено; повтор використовує ту саму відповідь.',
      );
    }
    const {
      rows: [saved],
    } = await sonarPool.query(
      `insert into analyses(company_id,campaign_id,version,model,cost_usd,result) values($1,$2,$3,$4,$5,$6) on conflict(company_id,campaign_id,version) do update set result=analyses.result returning id`,
      [
        input.companyId,
        input.campaignId,
        input.version,
        response.model,
        response.costUsd,
        result,
      ],
    );
    return {
      status: 'done',
      result: { analysisId: saved.id, ...result, costUsd: response.costUsd },
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
          ? 'Відповідь ІІ обрізана: збільште analysis.max_tokens. Витрати збережено.'
          : error.code === 'empty_content'
            ? 'ІІ не повернув текст аналізу. Витрати збережено; спробуйте іншу модель.'
            : `OpenRouter не повернув коректний аналіз (${error.code}). Витрати збережено.`,
      );
    }
    throw error;
  }
}
export async function registerAnalysisTasks() {
  await boss.createQueue('company.analyze');
  await runTask('company.analyze', (payload, id) =>
    runCompanyAnalysis(payload as Input, id),
  );
}
