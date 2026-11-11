import { afterAll, expect, it, vi } from 'vitest';
import { PaidHttpError } from '@sonar/core';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'records actual stub cost once, blocks zero budget, serializes concurrent spend',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runBudgetedRequest, reconcileBilling, paidErrorReason } =
      await import('./budget.js');
    const createdIds: string[] = [];
    const {
      rows: [original],
    } = await sonarPool.query(
      "select value from settings where key='budget.monthly_usd'",
    );
    const id = async () => {
      const { rows } = await sonarPool.query(
        "insert into tasks(type,idempotency_key) values('ai.assist',$1) returning id",
        [randomUUID()],
      );
      createdIds.push(rows[0].id);
      return rows[0].id as string;
    };
    try {
      const task = await id();
      const paid = vi.fn(async () => ({
        id: 'test-generation',
        model: 'test',
        text: 'result',
        costUsd: 0.0037,
        units: 47,
      }));
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','1') on conflict(key) do update set value=excluded.value",
      );
      await runBudgetedRequest('openrouter', 0.01, task, paid);
      await runBudgetedRequest('openrouter', 0.01, task, paid);
      expect(paid).toHaveBeenCalledTimes(1);
      const {
        rows: [spend],
      } = await sonarPool.query(
        'select cost_usd,units from spend_events where task_id=$1',
        [task],
      );
      expect(Number(spend.cost_usd)).toBe(0.0037);
      expect(Number(spend.units)).toBe(47);
      await sonarPool.query(
        "update settings set value='0' where key='budget.monthly_usd'",
      );
      const blocked = vi.fn(paid);
      await expect(
        runBudgetedRequest('openrouter', 0, await id(), blocked),
      ).rejects.toMatchObject({ scope: 'monthly' });
      expect(blocked).not.toHaveBeenCalled();
      await sonarPool.query(
        "update settings set value='1' where key='budget.monthly_usd'",
      );
      for (const status of [400, 403, 429, 500, 503]) {
        const httpId = await id();
        const http = vi.fn(async () => {
          throw new PaidHttpError(status);
        });
        await expect(
          runBudgetedRequest('openrouter', 0.01, httpId, http),
        ).rejects.toMatchObject({ status });
        await expect(
          runBudgetedRequest('openrouter', 0.01, httpId, http),
        ).rejects.toMatchObject({ status });
        expect(http).toHaveBeenCalledTimes(1);
        const row = (
          await sonarPool.query(
            'select cost_usd,meta from spend_events where task_id=$1',
            [httpId],
          )
        ).rows[0];
        expect(Number(row.cost_usd)).toBe(0);
        expect(row.meta.error).toEqual({ status });
        expect(paidErrorReason(status)).toContain(String(status));
      }
      const op = vi.fn(async () => ({
        id: randomUUID(),
        model: 'test',
        text: 'result',
        costUsd: 0.6,
        units: 1,
      }));
      const results = await Promise.allSettled([
        runBudgetedRequest('openrouter', 0.6, await id(), op),
        runBudgetedRequest('openrouter', 0.6, await id(), op),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(op).toHaveBeenCalledTimes(1);
      const {
        rows: [baseline],
      } = await sonarPool.query(
        'select coalesce(sum(cost_usd),0) as cost from spend_events',
      );
      await sonarPool.query(
        "update settings set value=$1 where key='budget.monthly_usd'",
        [JSON.stringify(Number(baseline.cost) + 0.3)],
      );
      const concurrent = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          id: randomUUID(),
          model: 'test',
          text: 'result',
          costUsd: 0.1,
          units: 1,
        };
      });
      const tenIds = await Promise.all(Array.from({ length: 10 }, () => id()));
      const tenResults = await Promise.allSettled(
        tenIds.map((task) =>
          runBudgetedRequest('openrouter', 0.1, task, concurrent),
        ),
      );
      expect(tenResults.filter((r) => r.status === 'fulfilled')).toHaveLength(
        3,
      );
      expect(concurrent).toHaveBeenCalledTimes(3);
      await sonarPool.query(
        "update settings set value='2' where key='budget.monthly_usd'",
      );
      const uncertainId = await id();
      await expect(
        runBudgetedRequest('openrouter', 0.1, uncertainId, async () => {
          throw Error('timeout');
        }),
      ).rejects.toThrow('невідомий');
      const duplicate = vi.fn(paid);
      await expect(
        runBudgetedRequest('openrouter', 0.1, uncertainId, duplicate),
      ).rejects.toThrow('невідомий');
      expect(duplicate).not.toHaveBeenCalled();
      await sonarPool.query(
        "update settings set value=$1 where key='budget.monthly_usd'",
        [JSON.stringify(Number(baseline.cost) + 0.5)],
      );
      const exceedsReserved = vi.fn(paid);
      await expect(
        runBudgetedRequest('openrouter', 0.3, await id(), exceedsReserved),
      ).rejects.toMatchObject({ scope: 'monthly' });
      expect(exceedsReserved).not.toHaveBeenCalled();
      const monthly = async () =>
        Number(
          (
            await sonarPool.query(`select sum(cost) as total from (
        select cost_usd as cost from spend_events where created_at >= date_trunc('month',now())
        union all select (result->>'billingEstimate')::numeric from tasks where result->>'billingPending'='true'
        and (result->>'billingAt')::timestamptz >= date_trunc('month',now())) x`)
          ).rows[0].total,
        );
      const before = await monthly();
      await sonarPool.query("update tasks set status='paused' where id=$1", [
        uncertainId,
      ]);
      expect(await reconcileBilling(uncertainId, false, null)).toBe(true);
      expect(await monthly()).toBeCloseTo(before - 0.1, 10);
      const chargedId = await id();
      await expect(
        runBudgetedRequest('openrouter', 0.1, chargedId, async () => {
          throw Error('network');
        }),
      ).rejects.toThrow('невідомий');
      await sonarPool.query("update tasks set status='paused' where id=$1", [
        chargedId,
      ]);
      const reserved = await monthly();
      expect(await reconcileBilling(chargedId, true, null)).toBe(true);
      expect(await monthly()).toBeCloseTo(reserved, 10);
      expect(
        (
          await sonarPool.query(
            "select count(*)::int as n from activity_log where action='billing.reconcile' and entity_id=any($1::text[])",
            [[uncertainId, chargedId]],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [createdIds],
      );
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [createdIds],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        createdIds,
      ]);
      if (original)
        await sonarPool.query(
          "update settings set value=$1 where key='budget.monthly_usd'",
          [JSON.stringify(original.value)],
        );
      else
        await sonarPool.query(
          "delete from settings where key='budget.monthly_usd'",
        );
    }
  },
  15000,
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
