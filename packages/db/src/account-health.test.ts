import { expect, it, vi } from 'vitest';

it('matches a send snapshot by task id instead of a nearby successful check', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
  vi.stubEnv(
    'REGISTRY_DATABASE_URL',
    'postgres://test:test@localhost:5432/test',
  );
  const { failureShotKindForEvent } = await import('./account-health.js');
  const event = {
    createdAt: '2026-11-20T17:28:00.000Z',
    details: { taskId: 'send-task' },
  } as never;
  expect(
    failureShotKindForEvent(
      event,
      {
        check: { at: '2026-11-20T17:28:01.000Z', taskId: 'check-task' },
        send: { at: '2026-11-20T17:28:02.000Z', taskId: 'send-task' },
      },
      ['check', 'send'],
    ),
  ).toBe('send');
});

it('keeps the time-based link for legacy events without a task id', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
  vi.stubEnv(
    'REGISTRY_DATABASE_URL',
    'postgres://test:test@localhost:5432/test',
  );
  const { failureShotKindForEvent } = await import('./account-health.js');
  expect(
    failureShotKindForEvent(
      {
        createdAt: '2026-11-20T17:28:00.000Z',
        details: {},
      } as never,
      { send: { at: '2026-11-20T17:29:00.000Z' } },
      ['send'],
    ),
  ).toBe('send');
});
