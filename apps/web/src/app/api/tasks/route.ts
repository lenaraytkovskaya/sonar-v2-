import { getSession } from '@/lib/auth';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!(await getSession()).user)
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { sonarPool } = await import('@sonar/db');
  const params = new URL(request.url).searchParams;
  const { rows } = await sonarPool.query(
    `select id,type,status,reason_uk,attempts,result,created_at from tasks
 where ($1::text is null or status::text=$1) and ($2::text is null or type=$2) order by created_at desc limit 200`,
    [params.get('status') || null, params.get('type') || null],
  );
  const { rows: counts } = await sonarPool.query(
    'select type,status,count(*)::int as count from tasks group by type,status',
  );
  return Response.json({ tasks: rows, counts });
}
