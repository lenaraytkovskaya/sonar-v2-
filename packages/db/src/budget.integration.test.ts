import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'records actual stub cost once, blocks zero budget, serializes concurrent spend',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runBudgetedRequest } = await import('./budget.js');
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
      const uncertainId = await id();
      await expect(
        runBudgetedRequest('openrouter', 0.1, uncertainId, async () => {
          throw Error('timeout');
        }),
      ).rejects.toThrow('timeout');
      const duplicate = vi.fn(paid);
      await expect(
        runBudgetedRequest('openrouter', 0.1, uncertainId, duplicate),
      ).rejects.toThrow('невідомий');
      expect(duplicate).not.toHaveBeenCalled();
      const exceedsReserved = vi.fn(paid);
      await expect(
        runBudgetedRequest('openrouter', 0.3, await id(), exceedsReserved),
      ).rejects.toMatchObject({ scope: 'monthly' });
      expect(exceedsReserved).not.toHaveBeenCalled();
    } finally {
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
