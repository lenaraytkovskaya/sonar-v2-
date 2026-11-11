export const dynamic = 'force-dynamic';
export async function GET() {
  let db = false,
    registry = false;
  try {
    const { sonarPool, registryPool } = await import('@sonar/db');
    const ping = (pool: typeof sonarPool) =>
      pool.query('select 1').then(
        () => true,
        () => false,
      );
    [db, registry] = await Promise.all([ping(sonarPool), ping(registryPool)]);
  } catch {
    /* Unconfigured database is unhealthy. */
  }
  return Response.json({ ok: db, db, registry }, { status: db ? 200 : 503 });
}
