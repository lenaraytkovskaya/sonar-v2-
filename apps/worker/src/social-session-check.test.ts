import { beforeEach, expect, it, vi } from 'vitest';
import { socialTarget } from '@sonar/core';
import {
  SocialProfileBusyError,
  SocialSessionCheckError,
  socialSessionCheckReasons,
} from '@sonar/core/social-session';
const { check, checkRecipient, modes } = vi.hoisted(() => ({
  check: vi.fn(),
  checkRecipient: vi.fn(),
  modes: [] as unknown[],
}));
vi.mock('./social-send-browser.js', () => ({
  socialSendBrowser: { check, checkRecipient },
}));
vi.mock('@sonar/core/social-session', async (original) => ({
  ...(await original<typeof import('@sonar/core/social-session')>()),
  resolveSocialSession: () => ({ cookies: [], proxy: {} }),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: {
    query: async (sql: string) =>
      sql.includes('select channel,status,settings')
        ? {
            rows: [
              {
                channel: 'facebook',
                status: 'active',
                settings: { sessionStatus: 'valid' },
              },
            ],
          }
        : { rows: [{ value: 1000 }] },
  },
}));
vi.mock('@sonar/db/tasks', () => ({ boss: {}, runTask: vi.fn() }));
vi.mock('@sonar/db/social-accounts', () => ({
  withSocialSessionCheck: async (...args: unknown[]) => {
    modes.push(args[3]);
    const callback = args[1] as (
      account: never,
      session: never,
    ) => Promise<unknown>;
    return callback(
      { id: 'synthetic', channel: 'facebook' } as never,
      {} as never,
    );
  },
}));
import {
  runFacebookRecipientCheck,
  runSocialSessionCheck,
} from './social-send.js';

beforeEach(() => {
  check.mockReset();
  checkRecipient.mockReset();
  modes.length = 0;
});

it('uses the mutating check mode for the ordinary session check', async () => {
  check.mockResolvedValueOnce(undefined);
  await runSocialSessionCheck({ accountId: 'synthetic' });
  expect(modes).toEqual(['check']);
});

it('uses the read-only recipient mode for Facebook recipient checks', async () => {
  checkRecipient.mockResolvedValueOnce({
    valid: false,
    reason: 'checkpoint',
    observation: { checkpointVisible: true },
  });
  const target = socialTarget(
    'https://www.facebook.com/profile.php?id=100000000000001',
  )!;
  await runFacebookRecipientCheck(
    { accountId: 'synthetic', target },
    'task-synthetic',
  );
  expect(modes).toEqual(['recipient']);
});

it.each(Object.keys(socialSessionCheckReasons))(
  'preserves safe adapter reason %s',
  async (reason) => {
    check.mockRejectedValueOnce(
      new SocialSessionCheckError(
        reason as keyof typeof socialSessionCheckReasons,
      ),
    );
    expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
      valid: false,
      reason,
    });
  },
);
it.each([
  [
    Object.assign(Error('secret URL cookies proxy credentials'), {
      name: 'TimeoutError',
    }),
    'timeout',
  ],
  [
    Error('net::ERR_TUNNEL_CONNECTION_FAILED https://user:secret@proxy.test/'),
    'proxy',
  ],
  [
    Error('net::ERR_CONNECTION_RESET https://private.test/?cookie=secret'),
    'network',
  ],
  [Error('https://user:secret@private.test/?cookies=secret'), 'unknown_auth'],
])(
  'classifies failures without exposing raw messages',
  async (error, reason) => {
    check.mockRejectedValueOnce(error);
    expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
      valid: false,
      reason,
    });
  },
);

it('passes only the safe worker diagnostic to the paused account outcome', async () => {
  const diagnostic = {
    version: 1,
    stage: 'auth',
    urlKind: 'home',
    navigationHttpStatus: 200,
    errorKind: 'timeout',
    visible: {
      legacyAuth: 0,
      semanticAuth: 0,
      captcha: 0,
      checkpoint: 0,
      login: 0,
    },
  } as const;
  const error = new SocialSessionCheckError('unknown_auth');
  error.diagnostic = diagnostic;
  error.errorKind = 'timeout';
  check.mockRejectedValueOnce(error);
  expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
    valid: false,
    reason: 'unknown_auth',
    diagnostic,
  });
  check.mockResolvedValueOnce(undefined);
  expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
    valid: true,
  });
  check.mockRejectedValueOnce(new SocialSessionCheckError('login_required'));
  expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
    valid: false,
    reason: 'login_required',
  });
});

it('preserves profile lock contention as a deferrable busy result', async () => {
  check.mockRejectedValueOnce(new SocialProfileBusyError());
  expect(await runSocialSessionCheck({ accountId: 'synthetic' })).toEqual({
    valid: false,
    busy: true,
    reason: 'unknown_auth',
  });
});
