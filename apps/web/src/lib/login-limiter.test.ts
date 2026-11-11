import { describe, expect, it } from 'vitest';
import { LoginLimiter, loginClientIp } from './login-limiter';
describe('login limiter', () => {
  it('allows five failures, blocks the sixth for the same email across IPs', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.begin(' A@example.com ', `ip${i}`)!(false);
    expect(l.begin('a@example.com', 'fresh')).toBeNull();
    expect(l.begin('other@example.com', 'fresh')).not.toBeNull();
  });
  it('limits an IP across different emails', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.begin(`email${i}`, 'ip')!(false);
    expect(l.begin('fresh', 'ip')).toBeNull();
    expect(l.begin('fresh', 'other')).not.toBeNull();
  });
  it('reserves concurrent attempts so races cannot bypass the limit', () => {
    const l = new LoginLimiter();
    const attempts = Array.from({ length: 5 }, () => l.begin('a', 'ip'));
    expect(attempts.every(Boolean)).toBe(true);
    expect(l.begin('a', 'ip')).toBeNull();
    attempts[0]!(true);
    expect(l.begin('a', 'ip')).not.toBeNull();
  });
  it('successful logins do not consume failures or erase prior failures', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 10; i++) l.begin('a', 'ip')!(true);
    for (let i = 0; i < 4; i++) l.begin('a', 'ip')!(false);
    l.begin('a', 'ip')!(true);
    l.begin('a', 'ip')!(false);
    expect(l.begin('a', 'ip')).toBeNull();
  });
  it('expires precisely at fifteen minutes', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    for (let i = 0; i < 5; i++) l.begin('a', 'ip')!(false);
    now = 899999;
    expect(l.begin('a', 'ip')).toBeNull();
    now = 900000;
    expect(l.begin('a', 'ip')).not.toBeNull();
  });
  it('uses a rolling window from the failed completion time', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    const finish = l.begin('a', 'ip')!;
    now = 1000;
    finish(false);
    for (let i = 0; i < 4; i++) l.begin('a', 'ip')!(false);
    now = 900000;
    expect(l.begin('a', 'ip')).toBeNull();
    now = 901000;
    expect(l.begin('a', 'ip')).not.toBeNull();
  });
  it('completion is idempotent and failed attempts expire independently', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    const finish = l.begin('a', 'ip')!;
    finish(false);
    finish(true);
    now = 1000;
    for (let i = 0; i < 4; i++) l.begin('a', 'ip')!(false);
    expect(l.begin('a', 'ip')).toBeNull();
    now = 900000;
    expect(l.begin('a', 'ip')).not.toBeNull();
  });
  it('takes the proxy-appended peer instead of a spoofed leading address', () => {
    expect(
      loginClientIp(new Headers({ 'x-forwarded-for': 'spoofed, 192.0.2.1' })),
    ).toBe('192.0.2.1');
    expect(loginClientIp(new Headers({ 'x-real-ip': '2001:db8::1' }))).toBe(
      '2001:db8::1',
    );
    expect(loginClientIp(new Headers({ 'x-forwarded-for': 'garbage' }))).toBe(
      'unknown',
    );
  });
});
