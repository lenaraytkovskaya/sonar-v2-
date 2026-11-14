import { expect, it, vi } from 'vitest';
const { reconcile, runTask, query } = vi.hoisted(() => ({
  reconcile: vi.fn(),
  runTask: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { connect: async () => ({ query, release: vi.fn() }) },
}));
vi.mock('@sonar/core/social-session', async (original) => ({
  ...(await original<typeof import('@sonar/core/social-session')>()),
  resolveSocialSession: () => ({ cookies: [], proxy: {} }),
}));
vi.mock('@sonar/db/social-inbox', () => ({
  emptySocialCheckpoint: vi.fn(),
  persistSocialInboxBatch: vi.fn(),
  reconcileSocialInbox: reconcile,
}));
vi.mock('@sonar/db/social-action', () => ({
  reserveSocialAction: vi.fn(async () => null),
}));
vi.mock('@sonar/db/social-accounts', () => ({
  releaseSocialFetchSession: vi.fn(),
}));
vi.mock('@sonar/db/tasks', () => ({
  runTask,
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));
import {
  registerSocialInboxTasks,
  runSocialInboxSync,
} from './social-inbox.js';
import { SocialSessionCheckError } from '@sonar/core/social-session';

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

it.each(['unknown_auth', 'login_required'] as const)(
  'persists only safe paused inbox diagnostics for %s',
  async (reason) => {
    query.mockReset().mockImplementation(async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : sql.startsWith('select id,channel')
          ? [
              {
                id: 'synthetic',
                channel: 'instagram',
                status: 'active',
                settings: { sessionStatus: 'valid' },
              },
            ]
          : sql.startsWith('select key,value')
            ? [
                { key: 'social.inbox.enabled', value: true },
                { key: 'social.inbox.poll_seconds', value: 60 },
                { key: 'social.inbox.daily_limit', value: 10 },
              ]
            : [],
    }));
    const diagnostic = {
      version: 1,
      stage: 'capture_auth',
      urlKind: 'inbox',
      navigationHttpStatus: 200,
      errorKind: 'timeout',
      visible: {
        legacyAuth: 0,
        semanticAuth: 0,
        captcha: 0,
        checkpoint: 0,
        login: 0,
      },
      capture: {
        received: 2,
        parsed: 1,
        verified: 0,
        persisted: 0,
        httpStatus: 200,
      },
    } as const;
    const error = new SocialSessionCheckError(reason);
    const unsafeDiagnostic = {
      ...diagnostic,
      rawUrl: 'https://private.test/?cookie=secret',
      capture: { ...diagnostic.capture, received: 999, viewerId: 'private' },
    };
    error.diagnostic = unsafeDiagnostic;
    const result = await runSocialInboxSync(
      { accountId: 'synthetic' },
      {
        sync: async () => {
          throw error;
        },
      },
    );
    expect(result).toMatchObject({
      status: 'paused',
      reasonCode: `social_inbox_${reason}`,
      result: { diagnostic },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|secret|https|viewerId|rawUrl/,
    );
    const update = query.mock.calls.find(([sql]) =>
      sql.startsWith("update channel_accounts set status='paused'"),
    )!;
    expect(JSON.parse(update[1][1])).toEqual({
      reasonUk: error.reasonUk,
      sessionCheckReason: reason,
      ...(reason === 'login_required' ? { sessionStatus: 'invalid' } : {}),
    });
  },
);
