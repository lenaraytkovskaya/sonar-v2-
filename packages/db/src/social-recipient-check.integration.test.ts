import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'deduplicates pending Facebook checks without creating messages or changing send counters',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { enqueueFacebookRecipientCheck } =
      await import('./social-recipient-check.js');
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
    await boss.createQueue('social.recipient.check');
    const userId = randomUUID();
    const accountId = randomUUID();
    const companyId = randomUUID();
    const contactId = randomUUID();
    const handle = `sonar${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const nextSendAt = new Date(Date.now() + 3_600_000);
    let taskIds: string[] = [];
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Recipient check test','unused')",
        [userId, `${handle}@example.test`],
      );
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,sent_day,attempt_count,next_send_at,settings) values($1,'facebook','Recipient check test','',$2,'active',20,7,3,$3,'{\"enabled\":true,\"sessionStatus\":\"valid\"}')",
        [accountId, userId, nextSendAt.toISOString()],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1,$2,'Recipient check test','UA')",
        [companyId, `s8-${companyId}`],
      );
      await sonarPool.query(
        "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,'social',$3,$3,'website')",
        [contactId, companyId, `https://www.facebook.com/${handle}/`],
      );
      const [first, second] = await Promise.all([
        enqueueFacebookRecipientCheck(companyId, contactId, userId),
        enqueueFacebookRecipientCheck(companyId, contactId, userId),
      ]);
      taskIds = [first.id, second.id];
      expect(first.id).toBe(second.id);
      expect([first.created, second.created].sort()).toEqual([false, true]);
      const { rows } = await sonarPool.query(
        `select
          (select count(*)::int from tasks where type='social.recipient.check' and payload->>'contactId'=$1 and status in ('queued','running')) as pending,
          (select count(*)::int from messages where account_id=$2) as messages,
          sent_day,attempt_count,next_send_at
         from channel_accounts where id=$2`,
        [contactId, accountId],
      );
      expect(rows[0]).toMatchObject({
        pending: 1,
        messages: 0,
        sent_day: '7',
        attempt_count: 3,
      });
      expect(new Date(rows[0].next_send_at).toISOString()).toBe(
        nextSendAt.toISOString(),
      );
    } finally {
      if (taskIds.length) {
        await sonarPool.query(
          "delete from pgboss.job where name='social.recipient.check' and data->>'taskId'=any($1::text[])",
          [taskIds],
        );
        await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
          taskIds,
        ]);
      }
      await sonarPool.query('delete from contacts where id=$1', [contactId]);
      await sonarPool.query('delete from companies where id=$1', [companyId]);
      await sonarPool.query('delete from channel_accounts where id=$1', [
        accountId,
      ]);
      await sonarPool.query('delete from users where id=$1', [userId]);
      await boss.stop({ graceful: true, timeout: 5000 });
    }
  },
);

afterAll(async () => {
  if (!enabled || !process.env.DATABASE_URL) return;
  const { sonarPool } = await import('./index.js');
  await sonarPool.end();
});
