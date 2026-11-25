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
  socialSendPriority: vi.fn(async () => null),
}));
vi.mock('@sonar/db/social-accounts', () => ({
  releaseSocialFetchSession: vi.fn(),
  prepareSocialSession: vi.fn(async () => ({ cookies: [], proxy: {} })),
  pauseSocialFetchSession: vi.fn(async (_c, id, reason) => {
    await query("update channel_accounts set status='paused'", [
      id,
      JSON.stringify({
        reasonUk:
          socialSessionCheckReasons[
            reason as keyof typeof socialSessionCheckReasons
          ],
        sessionCheckReason: reason,
        ...([
          'login_required',
          'cookies_invalid',
          'checkpoint',
          'captcha',
        ].includes(reason)
          ? { sessionStatus: 'invalid' }
          : {}),
      }),
    ]);
  }),
}));
vi.mock('@sonar/db/tasks', () => ({
  runTask,
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));
import {
  registerSocialInboxTasks,
  runSocialInboxSync,
} from './social-inbox.js';
import {
  SocialSessionCheckError,
  socialSessionCheckReasons,
} from '@sonar/core/social-session';

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

it.each([
  ['instagram', 'unknown_auth'],
  ['instagram', 'login_required'],
  ['facebook', 'unknown_auth'],
  ['facebook', 'login_required'],
] as const)(
  'pauses only confirmed %s authentication failures and persists safe details for %s',
  async (channel, reason) => {
    query.mockReset().mockImplementation(async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : sql.startsWith('select id,channel')
          ? [
              {
                id: 'synthetic',
                channel,
                status: 'active',
                settings: { sessionStatus: 'valid', inboxPollingEnabled: true },
              },
            ]
          : sql.startsWith('select key,value')
            ? [
                { key: 'social.inbox.enabled', value: true },
                { key: `social.inbox.${channel}.enabled`, value: true },
                { key: 'social.inbox.poll_seconds', value: 60 },
                { key: 'social.inbox.daily_limit', value: 10 },
                { key: 'social.inbox.max_threads', value: 50 },
                { key: 'social.inbox.max_messages', value: 100 },
                { key: 'social.inbox.quiet_hours', value: '00:00-07:00' },
                { key: 'social.inbox.timezone', value: 'Europe/Kyiv' },
                {
                  key: 'social.inbox.failure_backoff_base_seconds',
                  value: 300,
                },
                {
                  key: 'social.inbox.failure_backoff_max_seconds',
                  value: 3600,
                },
                { key: 'social.inbox.linkedin.enabled', value: false },
              ]
            : [],
    }));
    const diagnostic = {
      version: 1,
      stage: 'actor',
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
      history: {
        threadList: 0,
        messageRegions: 1,
        messageNodes: 2,
        pinRestore: 1,
        restoreConfirmation: 0,
        historyMissing: 1,
      },
      capture: {
        received: 2,
        parsed: 1,
        verified: 0,
        persisted: 0,
        httpStatus: 200,
      },
      actor: {
        reason: 'viewer_mismatch',
        hasPreviousMailbox: false,
        hasMailbox: true,
        hasActors: true,
        emptyEdges: false,
        allViewersMatchExpected: false,
        anyViewerMatchesExpected: false,
        anyActorMailboxMatchesExpected: true,
        responseMailboxMatchesExpected: true,
        allActorMailboxesMatchResponse: true,
        fields: {
          directThread: 'object',
          viewer: 'object',
          viewerId: 'digit_string',
          mailboxId: 'digit_string',
          threadViewerId: 'digit_string',
        },
      },
    } as const;
    const error = new SocialSessionCheckError(reason);
    const unsafeDiagnostic = {
      ...diagnostic,
      rawUrl: 'https://private.test/?cookie=secret',
      capture: { ...diagnostic.capture, received: 999, viewerId: 'private' },
      actor: {
        ...diagnostic.actor,
        viewerId: 'private',
        cookie: 'secret',
        fields: { ...diagnostic.actor.fields, rawId: 'private' },
      },
      history: {
        ...diagnostic.history,
        messageNodes: 999,
        text: 'private',
        url: 'secret',
      },
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
    const authSignal = reason === 'login_required';
    expect(result).toMatchObject(
      authSignal
        ? {
            status: 'paused',
            reasonCode: 'social_inbox_login_required',
            result: { diagnostic },
          }
        : {
            status: 'failed',
            reasonCode: 'social_inbox_actor_unknown_auth',
            result: { stage: 'actor', kind: 'unknown_auth' },
          },
    );
    expect(result).not.toHaveProperty('result.diagnostic.actor.viewerId');
    expect(JSON.stringify(result)).not.toMatch(
      /private|secret|https|rawId|rawUrl/,
    );
    const update = query.mock.calls.find(([sql]) =>
      sql.startsWith("update channel_accounts set status='paused'"),
    );
    if (authSignal) {
      expect(JSON.parse(update![1][1])).toEqual({
        reasonUk: error.reasonUk,
        sessionCheckReason: reason,
        sessionStatus: 'invalid',
      });
    } else expect(update).toBeUndefined();
  },
);
