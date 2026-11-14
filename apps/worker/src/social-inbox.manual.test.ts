import { expect, it, vi } from 'vitest';
const { reconcile, runTask } = vi.hoisted(() => ({
  reconcile: vi.fn(),
  runTask: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: {} }));
vi.mock('@sonar/db/social-inbox', () => ({
  emptySocialCheckpoint: vi.fn(),
  persistSocialInboxBatch: vi.fn(),
  reconcileSocialInbox: reconcile,
}));
vi.mock('@sonar/db/social-action', () => ({ reserveSocialAction: vi.fn() }));
vi.mock('@sonar/db/social-accounts', () => ({
  releaseSocialFetchSession: vi.fn(),
}));
vi.mock('@sonar/db/tasks', () => ({
  runTask,
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));
import { registerSocialInboxTasks } from './social-inbox.js';

it('does not reconcile or schedule a successor after a manual terminal result', async () => {
  await registerSocialInboxTasks({ sync: async () => ({ complete: false }) });
  expect(reconcile).toHaveBeenCalledTimes(1); // Startup only.
  const afterTerminal = runTask.mock.calls[0]![2] as (
    payload: object,
  ) => Promise<void>;
  await afterTerminal({ accountId: 'exact-account', mode: 'manual' });
  expect(reconcile).toHaveBeenCalledTimes(1);
  await afterTerminal({ accountId: 'automatic-account' });
  expect(reconcile).toHaveBeenCalledTimes(2);
});
