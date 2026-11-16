import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

/** Light poll for new-message notifications: unread count and the newest unread inbound message. */
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { sonarPool } = await import('@sonar/db');
  const {
    rows: [row],
  } = await sonarPool.query(
    `select (select count(*)::int from messages where direction='in' and read_at is null) as count,
       m.id,m.conversation_id as "conversationId",m.channel,left(m.body,140) as body,
       coalesce(m.sent_at,m.created_at) as at,co.name as "companyName"
     from (select 1) one
     left join lateral (select * from messages where direction='in' and read_at is null
       order by coalesce(sent_at,created_at) desc,id desc limit 1) m on true
     left join conversations v on v.id=m.conversation_id
     left join companies co on co.id=v.company_id`,
  );
  return Response.json(
    {
      count: row.count,
      latest: row.id
        ? {
            id: row.id,
            conversationId: row.conversationId,
            channel: row.channel,
            body: row.body,
            at: row.at,
            companyName: row.companyName,
          }
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
