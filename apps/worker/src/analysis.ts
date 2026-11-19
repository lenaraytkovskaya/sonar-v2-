import {
  BudgetExceeded,
  OpenRouterError,
  PaidHttpError,
  createOpenRouterClient,
  parseAnalysis,
  type ReasoningConfig,
  type TextModel,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { enqueueOutreachDrafts } from '@sonar/db/outreach';
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
    'select id,result,cost_usd,(select offer from campaigns where id=$2) as campaign_offer from analyses where company_id=$1 and campaign_id=$2 and version=$3',
    [input.companyId, input.campaignId, input.version],
  );
  if (existing) {
    if (existing.campaign_offer?.trim())
      await enqueueOutreachDrafts(
        input.companyId,
        input.campaignId,
        existing.id,
      );
    return {
      status: 'done',
      result: {
        analysisId: existing.id,
        ...existing.result,
        costUsd: Number(existing.cost_usd),
      },
    };
  }
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
  const minScore = Number(data.min_score ?? config['analysis.min_score']),
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
    typeof config['analysis.prompt'] !== 'string' ||
    !config['ai.reasoning'] ||
    typeof config['ai.reasoning'] !== 'object'
  )
    throw new TaskFailure(
      'analysis_config_invalid',
      'Перевірте налаштування ШІ-аналізу.',
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
  const {
    config: _config,
    analysisSpentUsd: rawAnalysisSpentUsd = 0,
    ...untrusted
  } = data;
  void _config;
  const analysisSpentUsd = Number.isFinite(Number(rawAnalysisSpentUsd))
    ? Math.max(0, Number(rawAnalysisSpentUsd))
    : 0;
  const messages = [
    { role: 'system' as const, content: config['analysis.prompt'] },
    {
      role: 'user' as const,
      content: JSON.stringify({ untrusted_data: untrusted }),
    },
  ];
  const estimateFor = (tokens: number) =>
    Math.ceil((Buffer.byteLength(JSON.stringify(messages)) + 100) / 3) *
      model.promptUsd +
    tokens * model.completionUsd +
    model.requestUsd;
  const estimate = estimateFor(maxTokens);
  if (
    !Number.isFinite(estimate) ||
    estimate < 0 ||
    estimate > maxUsd - analysisSpentUsd
  )
    return {
      status: 'paused',
      reasonCode: 'analysis_price_limit',
      reasonUk:
        'Оцінена вартість аналізу перевищує ліміт. Виберіть дешевшу модель або змініть ліміт.',
    };
  try {
    const api =
      client ?? createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
    const reasoning = config['ai.reasoning'] as ReasoningConfig;
    let response;
    try {
      response = await runBudgetedRequest('openrouter', estimate, taskId, () =>
        api.complete(model.id, messages, maxTokens, reasoning),
      );
    } catch (error) {
      if (
        !(error instanceof OpenRouterError) ||
        error.finishReason !== 'length'
      )
        throw error;
      await saveAnalysisUsage(taskId, error);
      const retryTokens = Math.min(maxTokens * 2, 10000);
      const retryEstimate = estimateFor(retryTokens);
      const firstAttemptCost = error.billing?.costUsd ?? estimate;
      const remainingUsd =
        maxUsd - analysisSpentUsd - Math.max(0, firstAttemptCost);
      if (
        retryTokens <= maxTokens ||
        !Number.isFinite(retryEstimate) ||
        retryEstimate > remainingUsd
      )
        throw new TaskFailure(
          'analysis_truncated',
          'Відповідь обрізана в межах ліміту вартості. Оберіть іншу дешеву модель у Налаштуваннях або збільште analysis.max_usd.',
        );
      response = await runBudgetedRequest(
        'openrouter',
        retryEstimate,
        taskId,
        () => api.complete(model.id, messages, retryTokens, reasoning),
        1,
      );
    }
    let result;
    try {
      result = parseAnalysis(response.text, data.contacts, data.offer);
    } catch {
      throw new TaskFailure(
        'analysis_schema_invalid',
        'ШІ повернув некоректний аналіз. Витрати збережено; повтор використовує ту саму відповідь.',
      );
    }
    const tx = await sonarPool.connect();
    let savedId: string;
    try {
      await tx.query('begin');
      const {
        rows: [saved],
      } = await tx.query(
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
      if (data.offer?.trim())
        await enqueueOutreachDrafts(
          input.companyId,
          input.campaignId,
          saved.id,
          tx,
        );
      await tx.query('commit');
      savedId = saved.id;
    } catch (error) {
      await tx.query('rollback');
      throw error;
    } finally {
      tx.release();
    }
    return {
      status: 'done',
      result: {
        analysisId: savedId,
        ...result,
        costUsd: response.costUsd,
        ...(response.usage ? { usage: response.usage } : {}),
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
    if (error instanceof OpenRouterError) {
      await saveAnalysisUsage(taskId, error);
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
          ? 'Відповідь ШІ обрізана і після повторної спроби. Модель витрачає ліміт на міркування — оберіть іншу дешеву модель у Налаштуваннях. Витрати збережено.'
          : error.code === 'empty_content'
            ? 'ШІ не повернув текст аналізу. Витрати збережено; спробуйте іншу модель.'
            : `OpenRouter не повернув коректний аналіз (${error.code}). Витрати збережено.`,
      );
    }
    throw error;
  }
}

async function saveAnalysisUsage(taskId: string, error: OpenRouterError) {
  if (!error.billing) return;
  const usage = {
    ...(error.billing.promptTokens !== undefined
      ? { promptTokens: error.billing.promptTokens }
      : {}),
    ...(error.billing.completionTokens !== undefined
      ? { completionTokens: error.billing.completionTokens }
      : {}),
    ...(error.billing.reasoningTokens !== undefined
      ? { reasoningTokens: error.billing.reasoningTokens }
      : {}),
    ...(error.finishReason ? { finishReason: error.finishReason } : {}),
  };
  await sonarPool.query(
    `update tasks set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('analysisUsage',$2::jsonb) where id=$1`,
    [taskId, JSON.stringify(usage)],
  );
}
export async function registerAnalysisTasks() {
  await boss.createQueue('company.analyze');
  await runTask('company.analyze', (payload, id) =>
    runCompanyAnalysis(payload as Input, id),
  );
}
