export const healthEventKinds = [
  'relogin_ok',
  'relogin_failed',
  'session_lost',
  'code_requested',
  'captcha',
  'checkpoint',
  'action_blocked',
  'rate_limited',
  'send_failed',
  'auto_paused',
  'auto_resumed',
] as const;
export type HealthEventKind = (typeof healthEventKinds)[number];
export type AccountHealthStatus = 'healthy' | 'watch' | 'warning' | 'paused';
export type HealthEvent = {
  id: string;
  kind: HealthEventKind;
  reasonUk: string;
  details: Record<string, unknown>;
  createdAt: string;
  failureShotKind?: 'check' | 'keepalive' | 'inbox' | 'send';
};
export type HealthConfig = {
  pause_hours: number;
  repeat_pause_hours: number;
  repeat_window_days: number;
  retention_days: number;
  summary_days: number;
  watch_send_failures: number;
  watch_relogins: number;
  warning_alarms: number;
};
export const pauseHealthKinds: readonly HealthEventKind[] = [
  'action_blocked',
  'rate_limited',
  'captcha',
  'checkpoint',
];
export const alarmHealthKinds: readonly HealthEventKind[] = [
  ...pauseHealthKinds,
  'relogin_failed',
  'session_lost',
  'code_requested',
  'send_failed',
];

export function isAccountHealthPaused(
  settings: Record<string, unknown>,
  now = new Date(),
): boolean {
  const until = Date.parse(String(settings.healthPauseUntil ?? ''));
  return (
    settings.healthAutoPaused === true &&
    Number.isFinite(until) &&
    until > now.getTime()
  );
}

/** Repeated successful checks do not restart an already running session. */
export function averageSessionHours(
  events: readonly HealthEvent[],
): number | null {
  let started: number | undefined;
  const durations: number[] = [];
  for (const event of [...events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )) {
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    if (event.kind === 'relogin_ok') started ??= at;
    if (event.kind === 'session_lost' && started !== undefined) {
      if (at >= started) durations.push((at - started) / 3_600_000);
      started = undefined;
    }
  }
  return durations.length
    ? durations.reduce((sum, hours) => sum + hours, 0) / durations.length
    : null;
}

export function calculateAccountHealth(input: {
  accountStatus: string;
  settings: Record<string, unknown>;
  createdAt: string;
  events: readonly HealthEvent[];
  config: HealthConfig;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const boundary = now.getTime() - input.config.repeat_window_days * 86_400_000;
  const history = input.events.filter(
    (event) => Date.parse(event.createdAt) <= now.getTime(),
  );
  const recent = history.filter(
    (event) => Date.parse(event.createdAt) >= boundary,
  );
  const alarms = history.filter((event) =>
    alarmHealthKinds.includes(event.kind),
  );
  const lastAlarmAt = alarms.reduce<string | null>(
    (last, event) =>
      !last || Date.parse(event.createdAt) > Date.parse(last)
        ? event.createdAt
        : last,
    null,
  );
  const count = (kind: HealthEventKind) =>
    recent.filter((event) => event.kind === kind).length;
  const warningCount = new Set(
    recent
      .filter(
        (event) =>
          pauseHealthKinds.includes(event.kind) || event.kind === 'auto_paused',
      )
      .map((event) =>
        event.kind === 'auto_paused' &&
        typeof event.details.triggerEventId === 'string'
          ? event.details.triggerEventId
          : event.id,
      ),
  ).size;
  let status: AccountHealthStatus = 'healthy';
  if (
    count('send_failed') >= input.config.watch_send_failures ||
    count('relogin_ok') + count('relogin_failed') >=
      input.config.watch_relogins ||
    recent.some((event) =>
      ['session_lost', 'code_requested'].includes(event.kind),
    )
  )
    status = 'watch';
  if (warningCount >= input.config.warning_alarms) status = 'warning';
  if (
    input.accountStatus === 'paused' ||
    isAccountHealthPaused(input.settings, now)
  )
    status = 'paused';
  const trackedSince = Math.max(
    Date.parse(input.createdAt),
    now.getTime() - input.config.retention_days * 86_400_000,
  );
  return {
    status,
    alarmCount7Days: recent.filter((event) =>
      alarmHealthKinds.includes(event.kind),
    ).length,
    lastAlarmAt,
    daysWithoutAlarms: Math.max(
      0,
      Math.floor(
        (now.getTime() -
          (lastAlarmAt ? Date.parse(lastAlarmAt) : trackedSince)) /
          86_400_000,
      ),
    ),
    averageSessionHours: averageSessionHours(history),
  };
}
