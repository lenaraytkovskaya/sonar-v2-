export const VIBER_MISSING_GRACE_MS = 20_000;
export const VIBER_MAX_RESTARTS = 5;

export function restartDelay(attempt: number) {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

export function canRestart(
  missingSince: number,
  now: number,
  attempts: number,
  lastAttempt: number,
) {
  return (
    now - missingSince >= VIBER_MISSING_GRACE_MS &&
    attempts < VIBER_MAX_RESTARTS &&
    now - lastAttempt >= restartDelay(attempts)
  );
}
