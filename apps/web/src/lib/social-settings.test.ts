import { describe, expect, it } from 'vitest';
import { socialFields, validSocialSettings } from './social-settings';
const valid = () => ({
  'social.enabled': true,
  ...Object.fromEntries(
    Object.entries(socialFields).map(([key, range]) => [key, range.min]),
  ),
});
describe('social settings', () => {
  it('accepts a complete bounded configuration', () =>
    expect(validSocialSettings(valid())).toBe(true));
  it('rejects partial, unknown, non-finite and fractional limit settings', () => {
    for (const value of [
      null,
      [],
      {},
      { ...valid(), secret: 'hidden' },
      { ...valid(), 'social.enabled': 'true' },
      { ...valid(), 'social.page_timeout_ms': 0 },
      { ...valid(), 'social.cost_per_request_usd': NaN },
      { ...valid(), 'social.facebook.daily_limit': 1.5 },
    ])
      expect(validSocialSettings(value)).toBe(false);
  });
});
