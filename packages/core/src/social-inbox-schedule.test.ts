import { describe, expect, it } from 'vitest';
import { nextSocialInboxPollAt } from './social-inbox-schedule.js';

describe('nextSocialInboxPollAt', () => {
  it('uses the normal interval with up to thirty percent jitter', () => {
    const now = new Date('2026-07-01T10:00:00.000Z');
    expect(
      nextSocialInboxPollAt(now, 600, '00:00-07:00', () => 0).toISOString(),
    ).toBe('2026-07-01T10:07:00.000Z');
    expect(
      nextSocialInboxPollAt(now, 600, '00:00-07:00', () => 1).toISOString(),
    ).toBe('2026-07-01T10:13:00.000Z');
  });

  it('checks quiet hours in Europe/Kyiv and polls hourly there', () => {
    const now = new Date('2026-07-01T00:00:00.000Z'); // 03:00 in Kyiv
    expect(
      nextSocialInboxPollAt(now, 180, '00:00-07:00', () => 0.5).toISOString(),
    ).toBe('2026-07-01T01:00:00.000Z');
  });

  it('supports quiet ranges that cross midnight', () => {
    const now = new Date('2026-07-01T21:30:00.000Z'); // 00:30 in Kyiv
    expect(
      nextSocialInboxPollAt(now, 300, '23:00-06:00', () => 0.5).toISOString(),
    ).toBe('2026-07-01T22:30:00.000Z');
  });

  it('rejects invalid intervals and quiet-hour ranges', () => {
    expect(() => nextSocialInboxPollAt(new Date(), 0)).toThrow();
    expect(() =>
      nextSocialInboxPollAt(new Date(), 60, '25:00-07:00'),
    ).toThrow();
  });
});
