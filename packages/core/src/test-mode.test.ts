import { describe, expect, it } from 'vitest';
import { recipientKey, testModeAllows } from './test-mode.js';

describe('test mode allowlist', () => {
  const list = [
    'Owner@Example.invalid',
    '+380 50 123 45 67',
    't.me/stub_user',
    'https://www.form.example.invalid/contact',
  ];
  it('matches recipients however they are written', () => {
    expect(testModeAllows('owner@example.invalid', list)).toBe(true);
    expect(testModeAllows('mailto:OWNER@example.invalid', list)).toBe(true);
    expect(testModeAllows('0501234567', list, 'UA')).toBe(true);
    expect(testModeAllows('https://wa.me/380501234567', list)).toBe(true);
    expect(testModeAllows('@stub_user', list)).toBe(true);
    expect(testModeAllows('https://form.example.invalid/feedback', list)).toBe(
      true,
    );
  });
  it('rejects everyone else', () => {
    expect(testModeAllows('sales@example.invalid', list)).toBe(false);
    expect(testModeAllows('+380501234568', list)).toBe(false);
    expect(testModeAllows('@other_user', list)).toBe(false);
    expect(testModeAllows('https://other.invalid/form', list)).toBe(false);
    expect(testModeAllows('owner@example.invalid', [])).toBe(false);
  });
  it('normalizes keys', () => {
    expect(recipientKey('https://t.me/Stub_User/')).toBe('@stub_user');
    expect(recipientKey('+380501234567')).toBe('+380501234567');
  });
});
