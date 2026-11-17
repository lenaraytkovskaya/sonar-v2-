export type WorkerHeartbeat = {
  at: string;
  startedAt: string;
  version: string;
};
export type WorkerHealth = {
  worker: boolean;
  heartbeatAt: string | null;
  startedAt: string | null;
  version: string | null;
};

export function workerHealth(
  heartbeat: Partial<WorkerHeartbeat> | null | undefined,
  staleSeconds = 180,
  now = new Date(),
): WorkerHealth {
  const at = Date.parse(heartbeat?.at ?? '');
  const limit =
    Number.isFinite(staleSeconds) && staleSeconds > 0 ? staleSeconds : 180;
  return {
    worker: Number.isFinite(at) && now.getTime() - at <= limit * 1000,
    heartbeatAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    startedAt: heartbeat?.startedAt ?? null,
    version: heartbeat?.version ?? null,
  };
}
