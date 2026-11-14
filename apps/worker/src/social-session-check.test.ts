import { expect, it, vi } from 'vitest';
import {
  SocialSessionCheckError,
  socialSessionCheckReasons,
} from '@sonar/core/social-session';
const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('./social-send-browser.js', () => ({ socialSendBrowser: { check } }));
vi.mock('@sonar/core/social-session', async (original) => ({
  ...(await original<typeof import('@sonar/core/social-session')>()),
  resolveSocialSession: () => ({ cookies: [], proxy: {} }),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { query: async () => ({ rows: [{ value: 1000 }] }) },
}));
vi.mock('@sonar/db/tasks', () => ({ boss: {}, runTask: vi.fn() }));
vi.mock('@sonar/db/social-accounts', () => ({
  withSocialSessionCheck: async (
    _id: string,
    callback: (account: unknown) => unknown,
  ) => callback({ id: 'synthetic', channel: 'linkedin' }),
}));
import { runSocialSessionCheck } from './social-send.js';
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
