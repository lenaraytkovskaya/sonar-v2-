import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { SocialSendError } from '@sonar/core/social-session';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'queues only human social replies and guards attempts, limits, sessions and refusals',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { sendEmailMessage } = await import('./email.js');
    const {
      ensureContactConversation,
      queueConversationReply,
      getConversationChat,
    } = await import('./inbound.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('message.send');
    const user = randomUUID(),
      account = randomUUID(),
      company = randomUUID(),
      campaign = randomUUID();
    const now = new Date('2026-11-12T10:00:00Z');
    const keys = [
      'send.hours',
      'send.time_zones',
      'social.send.min_gap_seconds',
      'social.send.max_gap_seconds',
    ];
    const original = (
      await sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    try {
      for (const [key, value] of [
        ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
        ['send.time_zones', { PL: 'Europe/Warsaw' }],
        ['social.send.min_gap_seconds', 120],
        ['social.send.max_gap_seconds', 300],
      ])
        await sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Social send test','stub')",
        [user, `${user}@invalid.test`],
      );
      await sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Social send','PL','uk','{}','{}','test',1,'{"social":true}','{}','auto','active')`,
        [campaign],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::uuid::text,'Social send','PL')",
        [company],
      );
      await sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$2)',
        [campaign, company],
      );
      const {
        rows: [contact],
      } = await sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual') returning id",
        [company, `https://www.instagram.com/sonar_test/`],
      );
      await sonarPool.query(
        `insert into channel_accounts(id,channel,name,address,daily_limit,owner_id,settings) values($1,'instagram','Social send','instagram',20,$2,'{"sessionStatus":"valid"}')`,
        [account, user],
      );
      const conversationId = await ensureContactConversation(contact.id);
      expect((await getConversationChat(conversationId)).socialAvailable).toBe(
        true,
      );
      const create = (
        requestId = randomUUID(),
        socialDelivery: 'browser' | 'manual' = 'browser',
      ) =>
        queueConversationReply(
          { conversationId, body: 'Human reply', requestId, socialDelivery },
          user,
        );
      const send = (
        id: string,
        sender: import('./email.js').ChannelSender,
        at = now,
      ) => sendEmailMessage(id, randomUUID(), sender, at, () => 0, 'social');
      const reset = () =>
        sonarPool.query(
          'update channel_accounts set next_send_at=null,daily_limit=100,status=\'active\',settings=\'{"sessionStatus":"valid"}\' where id=$1',
          [account],
        );
      const sender = vi.fn(async (_request, a) => {
        await a!.beforeSend!();
        return 'https://www.instagram.com/direct/t/123/';
      });
      const key = randomUUID(),
        first = await create(key);
      expect(await create(key)).toEqual(first);
      await expect(create(key, 'manual')).rejects.toThrow('Ключ повідомлення');
      await Promise.all([send(first.id, sender), send(first.id, sender)]);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(
        (
          await sonarPool.query(
            'select first_attempt_at,provider_id,status from messages where id=$1',
            [first.id],
          )
        ).rows[0],
      ).toMatchObject({ first_attempt_at: now, status: 'sent' });
      expect(
        (
          await sonarPool.query(
            'select next_send_at from channel_accounts where id=$1',
            [account],
          )
        ).rows[0].next_send_at,
      ).toEqual(new Date(now.getTime() + 120000));
      const limited = await create();
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      await sonarPool.query(
        'update channel_accounts set next_send_at=null,daily_limit=1 where id=$1',
        [account],
      );
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      await reset();
      const uncertain = await create();
      const ambiguous = vi.fn(async (_request, a) => {
        await a!.beforeSend!();
        throw Error('connection lost');
      });
      expect(await send(uncertain.id, ambiguous)).toMatchObject({
        status: 'paused',
        reasonUk: 'Перевірте чат вручну',
      });
      expect(await send(uncertain.id, ambiguous)).toMatchObject({
        status: 'paused',
        reasonCode: 'social_delivery_uncertain',
      });
      expect(ambiguous).toHaveBeenCalledTimes(1);
      await reset();
      const offline = await create();
      expect(
        await send(offline.id, async () => {
          throw new SocialSendError(
            'session_invalid',
            'Увійдіть знову (оновіть cookies)',
          );
        }),
      ).toMatchObject({ status: 'paused' });
      expect(
        (
          await sonarPool.query(
            'select status,first_attempt_at from messages where id=$1',
            [offline.id],
          )
        ).rows[0],
      ).toEqual({ status: 'queued', first_attempt_at: null });
      expect(
        (
          await sonarPool.query(
            'select status from channel_accounts where id=$1',
            [account],
          )
        ).rows[0].status,
      ).toBe('paused');
      expect((await getConversationChat(conversationId)).socialAvailable).toBe(
        false,
      );
      await expect(create()).rejects.toThrow('активний акаунт');
      expect((await create(randomUUID(), 'manual')).status).toBe('sent');
      await reset();
      expect(await send(offline.id, sender)).toMatchObject({ status: 'done' });
      await reset();
      const checkpoint = await create();
      const checkpointSend = vi.fn(async (_request, a) => {
        await a!.beforeSend!();
        throw new SocialSendError(
          'session_invalid',
          'Увійдіть знову (оновіть cookies)',
        );
      });
      expect(await send(checkpoint.id, checkpointSend)).toMatchObject({
        status: 'paused',
      });
      await reset();
      expect(await send(checkpoint.id, checkpointSend)).toMatchObject({
        status: 'paused',
        reasonCode: 'social_delivery_uncertain',
      });
      expect(checkpointSend).toHaveBeenCalledTimes(1);
      const unavailable = await create();
      expect(
        await send(unavailable.id, async () => {
          throw new SocialSendError(
            'unavailable',
            'Сторінка LinkedIn не приймає повідомлень',
          );
        }),
      ).toMatchObject({ status: 'skipped' });
      await reset();
      const blocked = await create();
      await sonarPool.query(
        "insert into do_not_contact(company_id,kind,value_normalized,reason) values($1::uuid,'company',$1::uuid::text,'Test refusal')",
        [company],
      );
      const blockedSender = vi.fn();
      expect(await send(blocked.id, blockedSender)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
      expect(blockedSender).not.toHaveBeenCalled();
      await expect(create()).rejects.toThrow('Не контактувати');
    } finally {
      await sonarPool.query(
        "delete from tasks where payload->>'messageId' in(select m.id::text from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1)",
        [company],
      );
      await sonarPool.query(
        'delete from activity_log where user_id=$1 or entity_id=$2',
        [user, company],
      );
      await sonarPool.query(
        'delete from messages where conversation_id in(select id from conversations where company_id=$1)',
        [company],
      );
      await sonarPool.query('delete from conversations where company_id=$1', [
        company,
      ]);
      await sonarPool.query('delete from do_not_contact where company_id=$1', [
        company,
      ]);
      await sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [company],
      );
      await sonarPool.query('delete from contacts where company_id=$1', [
        company,
      ]);
      await sonarPool.query('delete from companies where id=$1', [company]);
      await sonarPool.query('delete from campaigns where id=$1', [campaign]);
      await sonarPool.query('delete from channel_accounts where id=$1', [
        account,
      ]);
      await sonarPool.query('delete from users where id=$1', [user]);
      for (const setting of original)
        await sonarPool.query('update settings set value=$2 where key=$1', [
          setting.key,
          JSON.stringify(setting.value),
        ]);
      await admin.stop();
    }
  },
);
afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('./tasks.js');
  await closeTaskQueue();
  const { sonarPool, registryPool } = await import('./index.js');
  await Promise.all([sonarPool.end(), registryPool.end()]);
});
