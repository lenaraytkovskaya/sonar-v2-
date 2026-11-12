import type { PoolClient } from 'pg';
import {
  BudgetExceeded,
  PaidHttpError,
  OpenRouterError,
  checkBudget,
  moneyUnits,
  type PaidResponse,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { logActivity } from './tasks.js';
export class BillingUncertain extends Error {
  constructor() {
    super(
      'Результат попереднього платного запиту невідомий. Звірте витрати перед повтором.',
    );
  }
}
async function usage(client: PoolClient, service: string) {
  const {
    rows: [config],
  } = await client.query(
    'select monthly_limit_usd from services where code=$1',
    [service],
  );
  if (!config) throw new Error('Unknown service');
  const {
    rows: [setting],
  } = await client.query(
    "select value from settings where key='budget.monthly_usd'",
  );
  const {
    rows: [spent],
  } = await client.query(
    `with costs as (
 select service_code,cost_usd from spend_events where created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
 union all
 select result->>'billingService', (result->>'billingEstimate')::numeric from tasks
 where result->>'billingPending'='true' and (result->>'billingAt')::timestamptz >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
 ) select coalesce(sum(cost_usd),0) as monthly, coalesce(sum(cost_usd) filter(where service_code=$1),0) as service from costs`,
    [service],
  );
  return {
    monthlyLimitUsd: Number(
      setting?.value ?? process.env.MONTHLY_BUDGET_USD ?? 50,
    ),
    monthlySpentUsd: Number(spent.monthly),
    serviceLimitUsd:
      config.monthly_limit_usd === null
        ? null
        : Number(config.monthly_limit_usd),
    serviceSpentUsd: Number(spent.service),
  };
}
// The transaction lock protects only checking and reserving. Durable reservations
// count toward usage while external requests run concurrently, including after a crash.
export async function runBudgetedRequest(
  service: string,
  estimateUsd: number,
  taskId: string,
  operation: () => Promise<PaidResponse>,
): Promise<PaidResponse> {
  const client = await sonarPool.connect();
  let transaction = false;
  try {
    await client.query('begin');
    transaction = true;
    await client.query('select pg_advisory_xact_lock(719401)');
    const {
      rows: [previous],
    } = await client.query(
      'select service_code,meta from spend_events where task_id=$1',
      [taskId],
    );
    if (previous) {
      if (previous.service_code !== service)
        throw new Error('Task already billed to another service');
      await client.query('commit');
      transaction = false;
      if (previous.meta.error?.code)
        throw new OpenRouterError(
          previous.meta.error.code,
          undefined,
          previous.meta.error.finishReason,
        );
      if (previous.meta.error)
        throw new PaidHttpError(previous.meta.error.status);
      if (!previous.meta.response) throw new BillingUncertain();
      return previous.meta.response as PaidResponse;
    }
    const {
      rows: [task],
    } = await client.query('select result,type from tasks where id=$1', [
      taskId,
    ]);
    if (!task) throw new Error('Unknown task');
    if (task.result?.billingPending) throw new BillingUncertain();
    checkBudget(await usage(client, service), estimateUsd);
    if (
      service === 'google_places' ||
      service === 'twocaptcha' ||
      (service === 'openrouter' && task.type === 'company.analyze')
    ) {
      const {
        rows: [campaign],
      } = await client.query(
        `select c.id,c.budget_usd from tasks t left join batches b on b.id=t.batch_id left join messages m on m.id=(t.payload->>'messageId')::uuid left join conversations v on v.id=m.conversation_id join campaigns c on c.id=coalesce(b.campaign_id,(t.payload->>'campaignId')::uuid,v.campaign_id) where t.id=$1`,
        [taskId],
      );
      if (!campaign) throw Error('Paid request requires campaign');
      const {
        rows: [spent],
      } = await client.query(
        `select coalesce(sum(cost),0) as cost from (
        select s.cost_usd as cost from spend_events s join tasks t on t.id=s.task_id left join batches b on b.id=t.batch_id left join messages m on m.id=(t.payload->>'messageId')::uuid left join conversations v on v.id=m.conversation_id where coalesce(b.campaign_id,(t.payload->>'campaignId')::uuid,v.campaign_id)=$1
        union all select (t.result->>'billingEstimate')::numeric from tasks t left join batches b on b.id=t.batch_id left join messages m on m.id=(t.payload->>'messageId')::uuid left join conversations v on v.id=m.conversation_id where coalesce(b.campaign_id,(t.payload->>'campaignId')::uuid,v.campaign_id)=$1 and t.result->>'billingPending'='true'
      ) usage`,
        [campaign.id],
      );
      // 0 means no separate campaign cap; the monthly and service budgets still apply.
      if (
        moneyUnits(Number(campaign.budget_usd)) > 0n &&
        moneyUnits(Number(spent.cost)) + moneyUnits(estimateUsd) >
          moneyUnits(Number(campaign.budget_usd))
      )
        throw new BudgetExceeded('campaign');
    }
    await client.query(
      `update tasks set result=coalesce(result,'{}'::jsonb)||$2::jsonb where id=$1`,
      [
        taskId,
        JSON.stringify({
          billingPending: true,
          billingEstimate: estimateUsd,
          billingService: service,
          billingAt: new Date().toISOString(),
        }),
      ],
    );
    await client.query('commit');
    transaction = false;
    let response: PaidResponse;
    try {
      response = await operation();
    } catch (error) {
      const received = error instanceof OpenRouterError && error.billing;
      if (error instanceof PaidHttpError || received) {
        const cost = received ? (received.costUsd ?? estimateUsd) : 0;
        const meta =
          error instanceof OpenRouterError
            ? {
                error: {
                  code: error.code,
                  ...(error.finishReason
                    ? { finishReason: error.finishReason }
                    : {}),
                },
                costBasis:
                  received && received.costUsd !== undefined
                    ? 'provider_reported'
                    : 'estimated',
              }
            : { error: { status: error.status } };
        await client.query('begin');
        transaction = true;
        await client.query(
          'insert into spend_events(service_code,units,cost_usd,task_id,meta) values($1,$2,$3,$4,$5)',
          [service, received ? received.units : 0, cost, taskId, meta],
        );
        await client.query(
          `update tasks set result=result||'{"billingPending":false}'::jsonb where id=$1`,
          [taskId],
        );
        await client.query('commit');
        transaction = false;
        throw error;
      }
      if (error instanceof OpenRouterError) throw error;
      throw new BillingUncertain();
    }
    moneyUnits(response.costUsd);
    if (!Number.isSafeInteger(response.units) || response.units < 0)
      throw new Error('Invalid usage');
    await client.query('begin');
    transaction = true;
    await client.query(
      'insert into spend_events(service_code,units,cost_usd,task_id,meta) values($1,$2,$3,$4,$5)',
      [service, response.units, response.costUsd, taskId, { response }],
    );
    await client.query(
      `update tasks set result=coalesce(result,'{}'::jsonb)||'{"billingPending":false}'::jsonb where id=$1`,
      [taskId],
    );
    await client.query('commit');
    transaction = false;
    return response;
  } catch (error) {
    if (transaction) await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export function paidErrorReason(status: number, service = 'Google') {
  if (status === 400)
    return `${service}: некоректний запит або токен сторінки (400).`;
  if (status === 403)
    return `${service}: перевірте ключ і доступ до API (403).`;
  if (status === 429)
    return `${service}: квоту вичерпано (429). Повторіть пізніше.`;
  if (status >= 500)
    return `${service}: помилка сервера (${status}). Можна повторити.`;
  return `${service}: запит відхилено (${status}).`;
}
export async function reconcileBilling(
  taskId: string,
  charged: boolean,
  userId: string | null,
) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(719401)');
    const {
      rows: [task],
    } = await client.query(
      "select * from tasks where id=$1 and result->>'billingPending'='true' for update",
      [taskId],
    );
    if (!task || !['failed', 'paused'].includes(task.status)) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      'insert into spend_events(service_code,units,cost_usd,task_id,meta) values($1,$2,$3,$4,$5)',
      [
        task.result.billingService,
        charged ? 1 : 0,
        charged ? task.result.billingEstimate : 0,
        taskId,
        {
          reconciliation: charged ? 'charged' : 'not_charged',
          costBasis: 'estimated_tariff',
        },
      ],
    );
    await client.query(
      `update tasks set result=result||'{"billingPending":false,"billingReconciled":true}'::jsonb,status='failed',reason_code='billing_reconciled',reason_uk=$2 where id=$1`,
      [
        taskId,
        charged
          ? 'Витрати звірено: списано за оцінкою. Можна повторити.'
          : 'Витрати звірено: не списано. Можна повторити.',
      ],
    );
    if (task.batch_id)
      await client.query(
        `update batches set cost_usd=(select coalesce(sum(s.cost_usd),0) from spend_events s join tasks t on t.id=s.task_id where t.batch_id=$1) where id=$1`,
        [task.batch_id],
      );
    await logActivity(
      'billing.reconcile',
      'task',
      taskId,
      userId,
      { charged, estimateUsd: task.result.billingEstimate },
      client,
    );
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
