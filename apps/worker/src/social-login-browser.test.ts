import { expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { generateTotp } from '@sonar/core/social-login';
import { createSocialLoginBrowser } from './social-login-browser.js';
vi.mock('./social-send-browser.js', () => ({
  assertSocialSession: vi.fn(async (page: { state: string }) => {
    if (page.state !== 'authenticated') throw new Error('unconfirmed');
  }),
}));
type State =
  | 'login'
  | 'authenticated'
  | 'totp'
  | 'email'
  | 'sms'
  | 'wrong_password'
  | 'captcha'
  | 'checkpoint';
function fixture(
  afterPassword: State,
  afterCode: State | State[] = 'authenticated',
  initial: State = 'login',
) {
  const codeStates = Array.isArray(afterCode) ? [...afterCode] : [afterCode];
  const fills: { selector: string; value: string }[] = [];
  const page = {
    state: initial,
    locator: (selector: string) => {
      const locator = {
        filter: () => locator,
        first: () => locator,
        count: vi.fn(async () =>
          selector.includes('iframe')
            ? Number(page.state === 'captcha')
            : selector.includes('input[type="file"]')
              ? Number(page.state === 'checkpoint')
              : selector.includes('verificationCode')
                ? Number(['totp', 'email', 'sms'].includes(page.state))
                : 0,
        ),
        innerText: async () =>
          ({
            login: '',
            authenticated: '',
            captcha: '',
            totp: 'Enter code from authentication app',
            email: 'Enter code sent by email',
            sms: 'Enter SMS code',
            wrong_password: 'Incorrect password',
            checkpoint: 'Confirm your identity',
          })[page.state] ?? '',
        fill: vi.fn(async (value: string) => {
          fills.push({ selector, value });
        }),
        press: vi.fn(async () => {
          page.state =
            selector === 'input[type="password"]'
              ? afterPassword
              : (codeStates.shift() ?? 'authenticated');
        }),
      };
      return locator;
    },
    getByRole: () => ({ filter: () => ({ count: async () => 0 }) }),
    goto: vi.fn(),
    url: () => 'https://www.instagram.com/',
    setDefaultTimeout: vi.fn(),
    routeWebSocket: vi.fn(),
    waitForTimeout: vi.fn(),
  };
  const saved = {
    cookies: [{ name: 'sessionid', value: 'private' }],
    origins: [],
  };
  const context = {
    route: vi.fn(),
    newPage: vi.fn(async () => page),
    storageState: vi.fn(async () => saved),
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    version: () => '145.0.0.0',
    close: vi.fn(async () => {}),
  };
  const adapter = createSocialLoginBrowser(
    vi.fn(async () => browser as unknown as Browser),
  );
  const session = {
    proxy: { server: 'http://private-proxy:1234' },
    persistDevice: vi.fn(),
    persistStorageState: vi.fn(),
  };
  const challenge = { waitForCode: vi.fn(async () => '123456') };
  const login = (
    network: 'instagram' | 'facebook' | 'linkedin' = 'instagram',
    totpSecret?: string,
  ) =>
    adapter.login(
      { channel: network },
      session,
      {
        login: 'private-user',
        password: 'private-password',
        ...(totpSecret ? { totpSecret } : {}),
      },
      challenge,
      100,
    );
  return {
    adapter,
    login,
    page,
    context,
    browser,
    session,
    challenge,
    fills,
    saved,
  };
}
it.each(['instagram', 'facebook', 'linkedin'] as const)(
  'logs into %s and saves state with pinned device/proxy',
  async (network) => {
    const f = fixture('authenticated');
    expect(await f.login(network)).toEqual({ valid: true });
    expect(f.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: f.session.proxy,
        locale: 'uk-UA',
        userAgent: expect.stringContaining('145.0.0.0'),
      }),
    );
    expect(f.page.goto).toHaveBeenCalledWith(
      expect.stringContaining(`${network}.com`),
      expect.anything(),
    );
    expect(f.session.persistStorageState).toHaveBeenCalledWith(
      f.saved,
      expect.objectContaining({ userAgent: expect.any(String) }),
    );
    expect(f.context.close).toHaveBeenCalledOnce();
    await f.adapter.close();
  },
);
it('submits TOTP locally without asking for a manual code', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(59000);
  const f = fixture('totp');
  expect(await f.login('instagram', 'JBSWY3DPEHPK3PXP')).toEqual({
    valid: true,
  });
  expect(f.fills.at(-1)?.value).toBe(generateTotp('JBSWY3DPEHPK3PXP'));
  expect(f.challenge.waitForCode).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it.each(['email', 'sms'] as const)(
  'continues %s challenge in the same still-open browser context',
  async (kind) => {
    const f = fixture(kind);
    f.challenge.waitForCode.mockImplementation(async () => {
      expect(f.context.close).not.toHaveBeenCalled();
      expect(f.context.newPage).toHaveBeenCalledOnce();
      return '654321';
    });
    expect(await f.login()).toEqual({ valid: true });
    expect(f.challenge.waitForCode).toHaveBeenCalledWith(kind);
    expect(f.fills.at(-1)?.value).toBe('654321');
    expect(f.context.close).toHaveBeenCalledOnce();
  },
);
it('closes expired manual challenges without saving a session', async () => {
  const f = fixture('email');
  f.challenge.waitForCode.mockResolvedValue(null as unknown as string);
  expect(await f.login()).toEqual({ valid: false, reason: 'code_expired' });
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.session.persistStorageState).not.toHaveBeenCalled();
});
it.each(['wrong_password', 'captcha', 'checkpoint'] as const)(
  'stops at %s with no retry or saved session',
  async (state) => {
    const f = fixture(state);
    expect(await f.login()).toEqual({ valid: false, reason: state });
    expect(f.fills).toHaveLength(2);
    expect(f.challenge.waitForCode).not.toHaveBeenCalled();
    expect(f.session.persistStorageState).not.toHaveBeenCalled();
  },
);
it('does not enter credentials into an initial CAPTCHA', async () => {
  const f = fixture('authenticated', 'authenticated', 'captcha');
  expect(await f.login()).toEqual({ valid: false, reason: 'captcha' });
  expect(f.fills).toHaveLength(0);
});
it('requires manual action when an authenticator secret is missing', async () => {
  const f = fixture('totp');
  expect(await f.login()).toEqual({ valid: false, reason: 'checkpoint' });
  expect(f.challenge.waitForCode).not.toHaveBeenCalled();
});
it('does not retry an incorrect confirmation code', async () => {
  const f = fixture('email', 'email');
  expect(await f.login()).toEqual({ valid: false, reason: 'login_failed' });
  expect(f.challenge.waitForCode).toHaveBeenCalledOnce();
  expect(f.fills).toHaveLength(3);
});
it('blocks off-platform requests and allows only platform/CDN HTTPS', async () => {
  const f = fixture('authenticated');
  await f.login();
  const route = f.context.route.mock.calls[0] as unknown as [
    string,
    (route: unknown) => Promise<void>,
  ];
  for (const [url, allowed] of [
    ['https://www.instagram.com/accounts/login/', true],
    ['https://static.cdninstagram.com/file.js', true],
    ['http://www.instagram.com/', false],
    ['https://instagram.com.evil.example/', false],
    ['https://127.0.0.1/', false],
    ['https://www.instagram.com:444/', false],
  ] as const) {
    const request = {
      request: () => ({ url: () => url }),
      continue: vi.fn(),
      abort: vi.fn(),
    };
    await route[1](request);
    expect(allowed ? request.continue : request.abort).toHaveBeenCalledOnce();
  }
});
it('continues a TOTP step followed by email verification without starting a second login', async () => {
  const f = fixture('totp', ['email', 'authenticated']);
  expect(await f.login('instagram', 'JBSWY3DPEHPK3PXP')).toEqual({
    valid: true,
  });
  expect(f.challenge.waitForCode).toHaveBeenCalledOnce();
  expect(f.context.newPage).toHaveBeenCalledOnce();
  expect(f.fills).toHaveLength(4);
});
