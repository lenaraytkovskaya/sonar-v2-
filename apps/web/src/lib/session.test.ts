import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealData, unsealData } from 'iron-session';
import { safeReturnTo, sessionOptions, type SessionData } from './session';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('session boundary', () => {
  it.each([
    'https://evil.test',
    '//evil.test',
    '/\\evil.test',
    '/login',
    '/login?next=/',
    '/\n/evil.test',
    null,
  ])('rejects unsafe return location %s', (value) =>
    expect(safeReturnTo(value)).toBe('/'),
  );
  it('preserves a local destination', () =>
    expect(safeReturnTo('/companies/test?tab=history')).toBe(
      '/companies/test?tab=history',
    ));
  it('fails closed without a strong secret', () => {
    vi.stubEnv('AUTH_SECRET', 'short');
    expect(sessionOptions).toThrow('AUTH_SECRET');
  });
  it('uses secure, httpOnly cookies in production', () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-'.repeat(4));
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionOptions().cookieOptions).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });
  it('rejects forged and expired sessions', async () => {
    const password = 'test-secret-'.repeat(4);
    const user = { id: 'test-user', name: 'Test' };
    const sealed = await sealData({ user }, { password, ttl: 60 });
    expect(
      (await unsealData<SessionData>(sealed, { password, ttl: 60 })).user,
    ).toEqual(user);
    expect(
      (await unsealData<SessionData>('forged', { password, ttl: 60 })).user,
    ).toBeUndefined();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 180_000);
    expect(
      (await unsealData<SessionData>(sealed, { password, ttl: 60 })).user,
    ).toBeUndefined();
  });
});
