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
  it.each(['skipped', 'paused', 'failed'] as const)(
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
  it('passes the current paused result through instead of discarding it', async () => {
    const save = vi.fn(async () => {});
    const result = { valid: false, diagnostic: { version: 1 } };
    await executeTask(
      async () => ({
        status: 'paused',
        result,
        reasonCode: 'social_session_unknown_auth',
        reasonUk: 'Причина',
      }),
      save,
      false,
    );
    expect(save).toHaveBeenLastCalledWith(
      'paused',
      result,
      'social_session_unknown_auth',
      'Причина',
    );
  });
  it('keeps a deferred operation queued with an explanatory reason', async () => {
    const save = vi.fn(async () => {});
    await executeTask(
      async () => ({
        status: 'deferred',
        runAt: new Date('2026-11-13T08:00:00Z'),
        reasonCode: 'outside_send_hours',
        reasonUk: 'Наступне робоче вікно',
      }),
      save,
      false,
    );
    expect(save).toHaveBeenLastCalledWith(
      'queued',
      undefined,
      'outside_send_hours',
      'Наступне робоче вікно',
    );
  });
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
