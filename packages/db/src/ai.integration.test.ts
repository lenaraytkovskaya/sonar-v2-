import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'AI handler blocks at zero and records/reuses actual stub cost',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runAiAssist } = await import('../../../apps/worker/src/ai.js');
    const ids: string[] = [];
    const id = async () => {
      const { rows } = await sonarPool.query(
        "insert into tasks(type,idempotency_key) values('ai.assist',$1) returning id",
        [randomUUID()],
      );
      ids.push(rows[0].id);
      return rows[0].id as string;
    };
    const keys = ['ai.models', 'ai.model.cheap', 'budget.monthly_usd'];
    const { rows: original } = await sonarPool.query(
      'select key,value from settings where key=any($1)',
      [keys],
    );
    try {
      for (const [key, value] of Object.entries({
        'ai.models': [
          {
            id: 'test/model',
            name: 'Test',
            promptUsd: 0.000001,
            completionUsd: 0.000002,
            requestUsd: 0,
          },
        ],
        'ai.model.cheap': 'test/model',
        'budget.monthly_usd': 0,
      }))
        await sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      const client = {
        models: vi.fn(),
        complete: vi.fn(async () => ({
          id: 'stub',
          model: 'test/model',
          text: 'Покращений текст',
          costUsd: 0.00123,
          units: 42,
        })),
      };
      vi.stubEnv('OPENROUTER_API_KEY', '');
      const noKeyTask = await id();
      expect(
        await runAiAssist({ action: 'improve', text: 'Текст' }, noKeyTask),
      ).toMatchObject({ status: 'paused', reasonCode: 'api_key_missing' });
      expect(
        (
          await sonarPool.query('select result from tasks where id=$1', [
            noKeyTask,
          ])
        ).rows[0].result?.billingPending,
      ).toBeFalsy();
      expect(
        await runAiAssist(
          { action: 'improve', text: 'Текст' },
          await id(),
          client,
        ),
      ).toMatchObject({ status: 'paused', reasonCode: 'budget_exceeded' });
      expect(client.complete).not.toHaveBeenCalled();
      await sonarPool.query(
        "update settings set value='10' where key='budget.monthly_usd'",
      );
      const task = await id();
      expect(
        await runAiAssist({ action: 'shorter', text: 'Текст' }, task, client),
      ).toMatchObject({
        status: 'done',
        result: { text: 'Покращений текст', costUsd: 0.00123 },
      });
      await runAiAssist({ action: 'shorter', text: 'Текст' }, task, client);
      expect(client.complete).toHaveBeenCalledTimes(1);
      client.complete.mockResolvedValueOnce({
        id: 'campaign-stub',
        model: 'test/model',
        text: JSON.stringify({
          name: 'Авто',
          country_code: 'UA',
          language_code: 'uk',
          cities: ['Київ'],
          queries: [
            'СТО',
            'автосервіс',
            'ремонт авто',
            'діагностика',
            'шиномонтаж',
          ],
          offer: 'Послуги',
        }),
        costUsd: 0.001,
        units: 40,
      });
      expect(
        await runAiAssist(
          { action: 'campaign', text: 'автосервіси Києва' },
          await id(),
          client,
        ),
      ).toMatchObject({
        status: 'done',
        result: { suggestion: { country_code: 'UA' } },
      });
      client.complete.mockResolvedValueOnce({
        id: 'invalid-stub',
        model: 'test/model',
        text: '{"broken":true}',
        costUsd: 0.001,
        units: 40,
      });
      await expect(
        runAiAssist(
          { action: 'campaign', text: 'автосервіси Києва' },
          await id(),
          client,
        ),
      ).rejects.toMatchObject({ code: 'ai_schema_invalid' });

      expect(
        Number(
          (
            await sonarPool.query(
              'select cost_usd from spend_events where task_id=$1',
              [task],
            )
          ).rows[0].cost_usd,
        ),
      ).toBe(0.00123);
    } finally {
      vi.unstubAllEnvs();
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
