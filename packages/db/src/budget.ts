import type { PoolClient } from 'pg';
import {
  BudgetExceeded,
  checkBudget,
  moneyUnits,
  type PaidResponse,
} from '@sonar/core';
import { sonarPool } from './index.js';
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
      return previous.meta.response as PaidResponse;
    }
    const {
      rows: [task],
    } = await client.query('select result from tasks where id=$1', [taskId]);
    if (!task) throw new Error('Unknown task');
    if (task.result?.billingPending) throw new BillingUncertain();
    checkBudget(await usage(client, service), estimateUsd);
    if (service === 'google_places') {
      const {
        rows: [campaign],
      } = await client.query(
        `select c.id,c.budget_usd from tasks t join batches b on b.id=t.batch_id join campaigns c on c.id=b.campaign_id where t.id=$1`,
        [taskId],
      );
      if (!campaign) throw Error('Google request requires campaign batch');
      const {
        rows: [spent],
      } = await client.query(
        `select coalesce(sum(cost),0) as cost from (
        select s.cost_usd as cost from spend_events s join tasks t on t.id=s.task_id join batches b on b.id=t.batch_id where b.campaign_id=$1
        union all select (t.result->>'billingEstimate')::numeric from tasks t join batches b on b.id=t.batch_id where b.campaign_id=$1 and t.result->>'billingPending'='true'
      ) usage`,
        [campaign.id],
      );
      if (
        moneyUnits(Number(campaign.budget_usd)) === 0n ||
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
    const response = await operation();
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
