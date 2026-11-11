import { describe, expect, it } from 'vitest';
import { LoginLimiter, loginClientIp } from './login-limiter';
describe('login limiter', () => {
  it('allows five failures, blocks the sixth for the same email across IPs', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.begin(' A@example.com ', `ip${i}`)!(false);
    expect(l.begin('a@example.com', 'fresh')).toBeNull();
    expect(l.begin('other@example.com', 'fresh')).not.toBeNull();
  });
  it('allows twenty IP failures across emails and blocks the twenty-first', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 20; i++) {
      const finish = l.begin(`email${i}`, 'ip');
      expect(finish).not.toBeNull();
      finish!(false);
    }
    expect(l.begin('fresh', 'ip')).toBeNull();
    expect(l.begin('fresh', 'other')).not.toBeNull();
  });
  it('reserves all twenty concurrent IP attempts across distinct emails', () => {
    const l = new LoginLimiter();
    const attempts = Array.from({ length: 20 }, (_, i) =>
      l.begin(`email${i}`, 'ip'),
    );
    expect(attempts.every(Boolean)).toBe(true);
    expect(l.begin('fresh', 'ip')).toBeNull();
    attempts[0]!(true);
    const last = l.begin('fresh', 'ip');
    expect(last).not.toBeNull();
    last!(false);
    expect(l.begin('another', 'ip')).toBeNull();
  });
  it('expires IP failures precisely fifteen minutes after completion', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    const attempts = Array.from({ length: 20 }, (_, i) =>
      l.begin(`email${i}`, 'ip'),
    );
    now = 1000;
    attempts.forEach((finish) => finish!(false));
    now = 900000;
    expect(l.begin('fresh', 'ip')).toBeNull();
    now = 900999;
    expect(l.begin('fresh', 'ip')).toBeNull();
    now = 901000;
    expect(l.begin('fresh', 'ip')).not.toBeNull();
  });
  it('keeps the email limit at five even when the IP has capacity', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.begin('a', 'ip')!(false);
    expect(l.begin('a', 'ip')).toBeNull();
    expect(l.begin('b', 'ip')).not.toBeNull();
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
  it.each(['192.0.2.44', '2001:db8::44'])(
    'prefers Cloudflare client IP %s over proxy headers',
    (ip) => {
      expect(
        loginClientIp(
          new Headers({
            'cf-connecting-ip': ` ${ip} `,
            'x-forwarded-for': '192.0.2.1, 192.0.2.2',
            'x-real-ip': '192.0.2.3',
          }),
        ),
      ).toBe(ip);
    },
  );
  it.each(['', 'invalid', '192.0.2.1, 192.0.2.2'])(
    'falls back when Cloudflare IP is invalid: %s',
    (ip) => {
      expect(
        loginClientIp(
          new Headers({
            'cf-connecting-ip': ip,
            'x-forwarded-for': '192.0.2.1, 192.0.2.2',
          }),
        ),
      ).toBe('192.0.2.2');
    },
  );
});
