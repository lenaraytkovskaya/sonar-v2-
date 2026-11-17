export const dynamic = 'force-dynamic';
export async function GET() {
  let db = false,
    registry = false;
  let worker = false;
  try {
    const { sonarPool, registryPool } = await import('@sonar/db');
    const ping = (pool: typeof sonarPool) =>
      pool.query('select 1').then(
        () => true,
        () => false,
      );
    [db, registry] = await Promise.all([ping(sonarPool), ping(registryPool)]);
    if (db) {
      const { readWorkerHealth } = await import('@sonar/db/tasks');
      worker = (await readWorkerHealth()).worker;
    }
  } catch {
    /* Unconfigured database is unhealthy. */
  }
  return Response.json(
    { ok: db, db, registry, worker },
    { status: db ? 200 : 503 },
  );
}
