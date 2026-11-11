import { describe, expect, it } from 'vitest';
import { normalizePhone } from './index.js';
describe('normalizePhone', () => {
  it.each([
    ['067 123 45 67', 'UA', '+380671234567'],
    ['512 345 678', 'PL', '+48512345678'],
    ['030 901820', 'DE', '+4930901820'],
    ['(202) 555-0123', 'US', '+12025550123'],
    ['+48 512 345 678', 'UA', '+48512345678'],
    ['garbage', 'UA', null],
    ['', 'UA', null],
    ['12345', 'US', null],
    ['Call +380671234567 today', 'UA', null],
  ] as const)('%s (%s) → %s', (raw, country, expected) => {
    expect(normalizePhone(raw, country)).toBe(expected);
  });
});
