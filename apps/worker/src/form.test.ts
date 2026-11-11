import { afterEach, expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({
  query: vi.fn(),
  budget: vi.fn(),
  browser: vi.fn(),
  solve: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { query: stubs.query } }));
vi.mock('@sonar/db/budget', () => ({ runBudgetedRequest: stubs.budget }));
vi.mock('@sonar/db/forms', () => ({ sendFormMessage: stubs.send }));
vi.mock('./form-browser.js', () => ({ sendWebsiteForm: stubs.browser }));
vi.mock('./captcha.js', () => ({ solveTwoCaptcha: stubs.solve }));
import { runFormSend } from './form.js';
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const config = (provider: string) => ({
  rows: Object.entries({
    'scanner.timeout_ms': 15000,
    'scanner.max_bytes': 2000000,
    'scanner.max_pages': 5,
    'scanner.user_agent': 'Sonar',
    'captcha.provider': provider,
    'captcha.poll_ms': 5000,
    'captcha.timeout_ms': 120000,
  }).map(([key, value]) => ({ key, value })),
});
it.each(['manual', '2captcha'])(
  'requires both provider setting %s and key before paying',
  async (provider) => {
    stubs.query.mockResolvedValue(config(provider));
    vi.stubEnv('TWOCAPTCHA_API_KEY', '');
    stubs.send.mockImplementation(async (_id, _task, send) => send({}, {}));
    stubs.browser.mockResolvedValue({ status: 'awaiting_manual' });
    await runFormSend({ messageId: 'message' }, 'task');
    expect(stubs.browser.mock.calls[0]![1].solveCaptcha).toBeUndefined();
    expect(stubs.budget).not.toHaveBeenCalled();
  },
);
it('reserves configured tariff before solving and returns the settled token', async () => {
  vi.stubEnv('TWOCAPTCHA_API_KEY', 'stub-secret');
  stubs.query
    .mockResolvedValueOnce(config('2captcha'))
    .mockResolvedValueOnce({ rows: [{ unit_price_usd: '0.01' }] });
  stubs.send.mockImplementation(async (_id, _task, send) => send({}, {}));
  stubs.solve.mockResolvedValue({
    text: 'stub-token',
    costUsd: 0.002,
    units: 1,
  });
  stubs.budget.mockImplementation(async (_service, _cost, _task, operation) =>
    operation(),
  );
  stubs.browser.mockImplementation(async (_request, options) => ({
    token: await options.solveCaptcha({
      kind: 'turnstile',
      siteKey: 'stub',
      url: 'https://example.invalid',
    }),
  }));
  await expect(runFormSend({ messageId: 'message' }, 'task')).resolves.toEqual({
    token: 'stub-token',
  });
  expect(stubs.budget).toHaveBeenCalledWith(
    'twocaptcha',
    0.01,
    'task',
    expect.any(Function),
  );
  expect(stubs.solve).toHaveBeenCalledTimes(1);
});
