import { describe, expect, it } from 'vitest';
import {
  nextSocialInboxFailureAt,
  nextSocialInboxPollAt,
} from './social-inbox-schedule.js';

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
    expect(() =>
      nextSocialInboxPollAt(
        new Date(),
        60,
        '00:00-07:00',
        undefined,
        'Mars/Phobos',
      ),
    ).toThrow();
  });

  it('uses the configured timezone for quiet hours', () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    expect(
      nextSocialInboxPollAt(
        now,
        180,
        '00:00-07:00',
        () => 0.5,
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2026-07-01T00:03:00.000Z');
  });

  it('backs off failed syncs from the polling floor and caps the delay', () => {
    const now = new Date('2026-07-01T10:00:00.000Z');
    const schedule = (failureCount: number, random = 0.5) =>
      nextSocialInboxFailureAt(
        now,
        180,
        failureCount,
        300,
        1200,
        '00:00-07:00',
        () => random,
      );
    expect(schedule(1).toISOString()).toBe('2026-07-01T10:05:00.000Z');
    expect(schedule(2).toISOString()).toBe('2026-07-01T10:10:00.000Z');
    expect(schedule(5, 1).toISOString()).toBe('2026-07-01T10:20:00.000Z');
    expect(schedule(20, 0).toISOString()).toBe('2026-07-01T10:14:00.000Z');
  });

  it('keeps failure retries on the quiet-hours cadence', () => {
    const now = new Date('2026-07-01T00:00:00.000Z'); // 03:00 in Kyiv
    expect(
      nextSocialInboxFailureAt(
        now,
        180,
        1,
        300,
        1200,
        '00:00-07:00',
        () => 0.5,
      ).toISOString(),
    ).toBe('2026-07-01T01:00:00.000Z');
  });

  it('rejects invalid backoff settings', () => {
    expect(() =>
      nextSocialInboxFailureAt(new Date(), 60, 0, 30, 120),
    ).toThrow();
    expect(() =>
      nextSocialInboxFailureAt(new Date(), 60, 1, 120, 60),
    ).toThrow();
  });
});
