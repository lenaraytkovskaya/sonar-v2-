import { expect, it } from 'vitest';
import { workerHealth } from './worker-health.js';

const now = new Date('2026-11-17T13:10:00Z');
const heartbeat = {
  at: '2026-11-17T13:07:00Z',
  startedAt: '2026-11-17T12:00:00Z',
  version: '2.1.0',
};
it('treats the cutoff as healthy and becomes stale after it', () => {
  expect(workerHealth(heartbeat, 180, now).worker).toBe(true);
  expect(workerHealth(heartbeat, 179, now).worker).toBe(false);
  expect(workerHealth(heartbeat, 180, new Date(now.getTime() + 1)).worker).toBe(
    false,
  );
  expect(workerHealth(heartbeat, 240, now)).toEqual({
    worker: true,
    heartbeatAt: new Date(heartbeat.at).toISOString(),
    startedAt: heartbeat.startedAt,
    version: heartbeat.version,
  });
});
it('reports missing or invalid heartbeats as stopped and uses the safe default for invalid limits', () => {
  expect(workerHealth(null, 180, now).worker).toBe(false);
  expect(workerHealth({ at: 'invalid' }, 180, now).heartbeatAt).toBeNull();
  expect(workerHealth(heartbeat, Number.NaN, now).worker).toBe(true);
  expect(workerHealth(heartbeat, -1, now).worker).toBe(true);
});
