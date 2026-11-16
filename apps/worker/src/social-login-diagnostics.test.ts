import { expect, it } from 'vitest';
import { loginDiagnostics } from './social-login-browser.js';

it('reports the login stage without credentials or page text', () => {
  const error = new Error(
    'locator.fill: Timeout waiting for secret-user\nsecret-pass page dump',
  );
  error.name = 'TimeoutError';
  const report = loginDiagnostics(
    'instagram',
    { valid: false, reason: 'login_failed' },
    { stage: 'login_form', state: 'pending', path: '/accounts/login/', error },
    {
      login: 'secret-user',
      password: 'secret-pass',
      totpSecret: 'ABCDEFGHIJKLMNOP',
    },
  );
  expect(report).toEqual({
    channel: 'instagram',
    reason: 'login_failed',
    stage: 'login_form',
    state: 'pending',
    path: '/accounts/login/',
    error: 'TimeoutError: locator.fill: Timeout waiting for ***',
  });
  expect(JSON.stringify(report)).not.toContain('secret');
});
