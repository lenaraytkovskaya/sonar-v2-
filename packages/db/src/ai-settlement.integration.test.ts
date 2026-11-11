import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { createOpenRouterClient } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'settles received AI failures, preserves safe diagnostics and only leaves network failures pending',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { executeTask } = await import('@sonar/db/tasks');
    const { runAiAssist } = await import('../../../apps/worker/src/ai.js');
    const keys = [
      'ai.models',
      'ai.model.cheap',
      'ai.max_tokens',
      'budget.monthly_usd',
    ];
    const { rows: original } = await sonarPool.query(
      'select key,value from settings where key=any($1)',
      [keys],
    );
    const ids: string[] = [];
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [key, value] of Object.entries({
        'ai.models': [
          {
            id: 'test/model',
            promptUsd: 0.000001,
            completionUsd: 0.000002,
            requestUsd: 0,
          },
        ],
        'ai.model.cheap': 'test/model',
        'ai.max_tokens': { rewrite: 500, campaign: 2000, company_filters: 800 },
        'budget.monthly_usd': 100,
      }))
        await sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      const base = {
        id: 'stub',
        choices: [{ message: { content: 'text' } }],
        usage: { cost: 0.0012, total_tokens: 20 },
      };
      const cases = [
        {
          action: 'campaign',
          code: 'finish_reason',
          body: {
            ...base,
            choices: [
              { finish_reason: 'length', message: { content: '{private' } },
            ],
          },
          cost: 0.0012,
        },
        {
          action: 'improve',
          code: 'empty_content',
          body: {
            ...base,
            choices: [{ message: { content: '', reasoning: 'private-key' } }],
          },
          cost: 0.0012,
        },
        {
          action: 'company_filters',
          code: 'usage_missing',
          body: { ...base, usage: { total_tokens: 20 } },
        },
        { action: 'campaign', code: 'invalid_response', raw: '{private' },
        { action: 'campaign', code: 'network_unavailable' },
      ];
      for (const scenario of cases) {
        const {
          rows: [task],
        } = await sonarPool.query(
          "insert into tasks(type,idempotency_key) values('ai.assist',$1) returning id",
          [randomUUID()],
        );
        ids.push(task.id);
        const fetcher = vi.fn<typeof fetch>();
        if (scenario.body || scenario.raw)
          fetcher.mockResolvedValue(
            new Response(scenario.raw ?? JSON.stringify(scenario.body)),
          );
        else
          fetcher.mockRejectedValue(
            new DOMException('private-key', 'TimeoutError'),
          );
        const client = createOpenRouterClient('private-key', fetcher);
        const run = () =>
          executeTask(
            () =>
              runAiAssist(
                { action: scenario.action, text: 'test' },
                task.id,
                client,
              ),
            async (status, _result, code, reason) => {
              await sonarPool.query(
                'update tasks set status=$2,reason_code=$3,reason_uk=$4 where id=$1',
                [task.id, status, code ?? null, reason ?? null],
              );
            },
            false,
          );
        if (scenario.code === 'network_unavailable') await run();
        else await expect(run()).rejects.toMatchObject({ code: scenario.code });
        const {
          rows: [saved],
        } = await sonarPool.query('select * from tasks where id=$1', [task.id]);
        expect(saved.reason_code).toBe(scenario.code);
        expect(saved.result.error.code).toBe(scenario.code);
        expect(saved.status).toBe(
          scenario.code === 'network_unavailable' ? 'paused' : 'failed',
        );
        if (scenario.code === 'finish_reason')
          expect(saved.reason_uk).toBe(
            'Відповідь ІІ обрізана, збільште ліміт токенів',
          );
        const { rows: spend } = await sonarPool.query(
          'select * from spend_events where task_id=$1',
          [task.id],
        );
        if (scenario.code === 'network_unavailable') {
          expect(saved.result.billingPending).toBe(true);
          expect(spend).toHaveLength(0);
        } else {
          expect(saved.result.billingPending).toBe(false);
          expect(spend).toHaveLength(1);
          expect(Number(spend[0].cost_usd)).toBeCloseTo(
            scenario.cost ?? saved.result.billingEstimate,
            8,
          );
          expect(spend[0].meta.costBasis).toBe(
            scenario.cost ? 'provider_reported' : 'estimated',
          );
          await expect(run()).rejects.toMatchObject({ code: scenario.code });
          expect(fetcher).toHaveBeenCalledTimes(1);
          expect(
            (
              await sonarPool.query(
                'select id from spend_events where task_id=$1',
                [task.id],
              )
            ).rowCount,
          ).toBe(1);
        }
        expect(
          JSON.stringify({ saved: saved.result, spend, logs: log.mock.calls }),
        ).not.toContain('private');
        expect(
          JSON.parse(fetcher.mock.calls[0]![1]!.body as string).max_tokens,
        ).toBe(
          (
            { campaign: 2000, company_filters: 800, improve: 500 } as Record<
              string,
              number
            >
          )[scenario.action],
        );
      }
      // Migration is idempotent and preserves values higher than new defaults.
      const migration = readFileSync(
        new URL('../drizzle/0008_ai_action_limits.sql', import.meta.url),
        'utf8',
      );
      for (const value of [500, 3200]) {
        await sonarPool.query(
          "update settings set value=$1 where key='ai.max_tokens'",
          [JSON.stringify(value)],
        );
        await sonarPool.query(migration);
        await sonarPool.query(migration);
        expect(
          (
            await sonarPool.query(
              "select value from settings where key='ai.max_tokens'",
            )
          ).rows[0].value,
        ).toEqual({
          rewrite: value,
          campaign: Math.max(value, 2000),
          company_filters: Math.max(value, 800),
        });
      }
    } finally {
      log.mockRestore();
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from settings where key=any($1)', [keys]);
      for (const row of original)
        await sonarPool.query('insert into settings(key,value) values($1,$2)', [
          row.key,
          JSON.stringify(row.value),
        ]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
