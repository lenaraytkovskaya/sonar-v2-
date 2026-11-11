import { afterAll, describe, expect, it, vi } from 'vitest';
process.env.DATABASE_URL ??=
  'postgres://test:local-test-only@localhost:55433/sonar';
process.env.REGISTRY_DATABASE_URL ??=
  'postgres://test:local-test-only@localhost:55433/registry';
const { executeTask } = await import('./tasks.js');
const { sonarPool, registryPool } = await import('./index.js');
afterAll(async () => {
  await Promise.all([sonarPool.end(), registryPool.end()]);
});
describe('task transitions', () => {
  it('records running then done with result', async () => {
    const save = vi.fn(async () => {});
    await executeTask(
      async () => ({ status: 'done', result: { count: 3 } }),
      save,
      false,
    );
    expect(save.mock.calls).toEqual([['running'], ['done', { count: 3 }]]);
  });
  it.each(['skipped', 'paused'] as const)(
    'records %s and reason',
    async (status) => {
      const save = vi.fn(async () => {});
      await executeTask(
        async () => ({ status, reasonCode: 'test', reasonUk: 'Причина' }),
        save,
        false,
      );
      expect(save).toHaveBeenLastCalledWith(
        status,
        undefined,
        'test',
        'Причина',
      );
    },
  );
  it.each([true, false])(
    'requeues only when retries remain: %s',
    async (retry) => {
      const save = vi.fn(async () => {});
      await expect(
        executeTask(
          async () => {
            throw Error('unavailable');
          },
          save,
          retry,
        ),
      ).rejects.toThrow('unavailable');
      expect(save.mock.calls.map((x) => x[0])).toEqual([
        'running',
        retry ? 'queued' : 'failed',
      ]);
    },
  );
});
