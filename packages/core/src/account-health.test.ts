import { describe, expect, it } from 'vitest';
import {
  averageSessionHours,
  calculateAccountHealth,
  isAccountHealthPaused,
  type HealthConfig,
  type HealthEvent,
  type HealthEventKind,
} from './account-health.js';
const now = new Date('2026-11-17T12:00:00Z');
const config: HealthConfig = {
  pause_hours: 24,
  repeat_pause_hours: 48,
  repeat_window_days: 7,
  retention_days: 90,
  summary_days: 14,
  watch_send_failures: 1,
  watch_relogins: 1,
  warning_alarms: 1,
};
const event = (
  kind: HealthEventKind,
  createdAt = now.toISOString(),
): HealthEvent => ({
  id: kind + createdAt,
  kind,
  createdAt,
  reasonUk: 'Причина',
  details: {},
});
const calculate = (events: HealthEvent[], accountStatus = 'active') =>
  calculateAccountHealth({
    events,
    accountStatus,
    settings: {},
    createdAt: '2026-10-01T00:00:00Z',
    config,
    now,
  });
describe('account health', () => {
  it('applies status precedence and ignores alarms outside the configured window', () => {
    expect(calculate([]).status).toBe('healthy');
    expect(calculate([event('send_failed')]).status).toBe('watch');
    expect(calculate([event('relogin_ok')]).status).toBe('watch');
    expect(calculate([event('send_failed'), event('captcha')]).status).toBe(
      'warning',
    );
    expect(calculate([event('captcha')], 'paused').status).toBe('paused');
    expect(calculate([event('captcha', '2026-11-01T00:00:00Z')]).status).toBe(
      'healthy',
    );
  });
  it('uses configured thresholds and preserves the full alarm streak', () => {
    expect(
      calculateAccountHealth({
        accountStatus: 'active',
        settings: {},
        createdAt: '2026-10-01T00:00:00Z',
        events: [event('send_failed')],
        config: { ...config, watch_send_failures: 2 },
        now,
      }).status,
    ).toBe('healthy');
    expect(calculate([event('captcha', '2026-11-01T12:00:00Z')])).toMatchObject(
      {
        alarmCount7Days: 0,
        daysWithoutAlarms: 16,
        lastAlarmAt: '2026-11-01T12:00:00Z',
      },
    );
  });
  it('counts an automatic pause and its triggering alarm once for warning thresholds', () => {
    const captcha = event('captcha');
    expect(
      calculateAccountHealth({
        accountStatus: 'active',
        settings: {},
        createdAt: '2026-10-01T00:00:00Z',
        events: [
          captcha,
          { ...event('auto_paused'), details: { triggerEventId: captcha.id } },
        ],
        config: { ...config, warning_alarms: 2 },
        now,
      }).status,
    ).toBe('healthy');
  });
  it('checks pause expiry without treating missing or malformed dates as active', () => {
    expect(
      isAccountHealthPaused(
        { healthAutoPaused: true, healthPauseUntil: '2026-11-18T00:00:00Z' },
        now,
      ),
    ).toBe(true);
    expect(
      isAccountHealthPaused(
        { healthAutoPaused: true, healthPauseUntil: now.toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      isAccountHealthPaused(
        { healthAutoPaused: true, healthPauseUntil: 'invalid' },
        now,
      ),
    ).toBe(false);
  });
  it('averages completed sessions, keeps original start on repeated success and ignores unmatched losses', () => {
    expect(averageSessionHours([event('session_lost')])).toBeNull();
    expect(
      averageSessionHours([
        event('session_lost', '2026-11-17T06:00:00Z'),
        event('relogin_ok', '2026-11-17T00:00:00Z'),
        event('relogin_ok', '2026-11-17T03:00:00Z'),
        event('relogin_ok', '2026-11-17T07:00:00Z'),
        event('session_lost', '2026-11-17T09:00:00Z'),
        event('relogin_ok', '2026-11-17T10:00:00Z'),
      ]),
    ).toBe(4);
  });
});
