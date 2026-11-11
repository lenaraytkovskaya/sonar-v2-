export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const { sonarPool } = await import('@sonar/db');
    await sonarPool.query('select 1');
    return Response.json({ ok: true, db: true });
  } catch {
    return Response.json({ ok: true, db: false });
  }
}
