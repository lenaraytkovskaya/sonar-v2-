import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

it.skipIf(process.env.RUN_DB_TESTS !== '1')(
  'prioritizes only runnable Facebook sends, bounds busy retries and preserves the durable attempt marker',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { socialSendPriority } = await import('./social-action.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('message.send');
    const c = await sonarPool.connect();
    const account = randomUUID(),
      conversation = randomUUID(),
      message = randomUUID(),
      task = randomUUID();
    let job: string | null = null;
    try {
      await c.query('begin');
      await c.query(
        "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','Priority fixture','','active',20,'{\"sessionStatus\":\"valid\"}')",
        [account],
      );
      await c.query(
        "insert into conversations(id,account_id,channel) values($1,$2,'social')",
        [conversation, account],
      );
      await c.query(
        "insert into messages(id,conversation_id,account_id,channel,to_value,subject,body,status,idempotency_key,first_attempt_at) values($1::uuid,$2::uuid,$3::uuid,'social','fixture','','fixture','queued',$1::text,now())",
        [message, conversation, account],
      );
      await c.query(
        "insert into tasks(id,type,status,idempotency_key,payload) values($1::uuid,'message.send','queued',$1::text,jsonb_build_object('messageId',$2::text))",
        [task, message],
      );
      const before = (
        await c.query('select first_attempt_at from messages where id=$1', [
          message,
        ])
      ).rows[0];
      expect(await socialSendPriority(c, account)).toBeNull(); // Orphan task.
      job = await admin.send('message.send', { taskId: task });
      expect(await socialSendPriority(c, account)).toMatchObject({
        status: 'deferred',
        reasonCode: 'social_send_priority',
      });
      await c.query("update tasks set status='paused' where id=$1", [task]);
      expect(await socialSendPriority(c, account)).toBeNull();
      await c.query(
        "update tasks set status='queued',reason_code='social_profile_busy' where id=$1",
        [task],
      );
      await c.query(
        "update messages set scheduled_at=now()+make_interval(secs => (select value::int from settings where key='social.profile.busy_retry_seconds')) where id=$1",
        [message],
      );
      expect(await socialSendPriority(c, account)).toMatchObject({
        status: 'deferred',
      });
      await c.query(
        "update messages set scheduled_at=now()+interval '1 hour' where id=$1",
        [message],
      );
      expect(await socialSendPriority(c, account)).toBeNull();
      await c.query('update messages set scheduled_at=null where id=$1', [
        message,
      ]);
      await c.query(
        "update pgboss.job set start_after=now()+interval '1 hour' where id=$1",
        [job],
      );
      expect(await socialSendPriority(c, account)).toBeNull();
      await c.query("update channel_accounts set status='paused' where id=$1", [
        account,
      ]);
      expect(await socialSendPriority(c, account)).toBeNull();
      expect(
        (
          await c.query('select first_attempt_at from messages where id=$1', [
            message,
          ])
        ).rows[0],
      ).toEqual(before);
    } finally {
      await c.query('rollback');
      c.release();
      if (job)
        await sonarPool.query(
          "delete from pgboss.job where name='message.send' and id=$1",
          [job],
        );
      await admin.stop();
    }
  },
);
afterAll(async () => {
  if (process.env.RUN_DB_TESTS === '1')
    await (await import('./index.js')).sonarPool.end();
});
