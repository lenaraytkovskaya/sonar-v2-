import { expect, it } from 'vitest';
import {
  canRestart,
  restartDelay,
  VIBER_MAX_RESTARTS,
  VIBER_MISSING_GRACE_MS,
} from './supervisor.js';

it('waits for missing Viber and applies bounded exponential backoff', () => {
  const started = 10_000;
  expect(canRestart(started, started + VIBER_MISSING_GRACE_MS - 1, 0, 0)).toBe(
    false,
  );
  expect(canRestart(started, started + VIBER_MISSING_GRACE_MS, 0, 0)).toBe(
    true,
  );
  expect(restartDelay(1)).toBe(2000);
  expect(restartDelay(3)).toBe(8000);
  expect(restartDelay(10)).toBe(60_000);
  expect(canRestart(started, started + 100_000, VIBER_MAX_RESTARTS, 0)).toBe(
    false,
  );
  expect(
    canRestart(
      started,
      started + VIBER_MISSING_GRACE_MS + 1000,
      2,
      started + VIBER_MISSING_GRACE_MS,
    ),
  ).toBe(false);
});
