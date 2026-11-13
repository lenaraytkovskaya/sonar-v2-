import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { campaignSchema } from '@sonar/core';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./social-send-browser.js', () => ({
  socialSendBrowser: { send, close: vi.fn() },
}));
vi.mock('@sonar/core/social-session', async (original) => ({
  ...(await original<typeof import('@sonar/core/social-session')>()),
  resolveSocialSession: () => ({ cookies: [], proxy: {} }),
}));

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'dispatches a human Instagram reply through pg-boss with UI-supported campaign channels',
  async () => {
    const { sonarPool } = await import('@sonar/db');
    const { boss } = await import('@sonar/db/tasks');
    const { ensureContactConversation, queueConversationReply } =
      await import('@sonar/db/inbound');
    const { registerEmailTasks } = await import('./email.js');
    const user = randomUUID(),
      company = randomUUID(),
      campaign = randomUUID(),
      account = randomUUID();
    const keys = ['send.hours', 'send.time_zones'];
    const original = (
      await sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    let messageId: string | undefined;
    try {
      await sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      await sonarPool.query(
        "update settings set value=$1 where key='send.time_zones'",
        [JSON.stringify({ PL: 'UTC' })],
      );
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Synthetic worker test','stub')",
        [user, `${user}@invalid.test`],
      );
      await sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status)
         values($1,'Synthetic worker test','PL','uk','{}','{}','test',0,$2,'{}','manual','active')`,
        [
          campaign,
          campaignSchema.shape.channels.parse({
            email: false,
            telegram: false,
            whatsapp: false,
            forms: false,
          }),
        ],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::uuid::text,'Synthetic worker test','PL')",
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
        [company, 'https://www.instagram.com/synthetic_test/'],
      );
      await sonarPool.query(
        `insert into channel_accounts(id,channel,name,address,daily_limit,settings)
         values($1,'instagram','Synthetic worker test','synthetic',20,'{"sessionStatus":"valid"}')`,
        [account],
      );
      // Only this fake transport is reachable; no browser or social credentials.
      send.mockImplementation(async (...args: unknown[]) => {
        const beforeSend = args[5] as () => Promise<void>;
        await beforeSend();
        return 'synthetic-provider-id';
      });
      await boss.start();
      await boss.createQueue('message.send');
      // Other DB tests call handlers directly and remove tasks, leaving orphan jobs.
      await sonarPool.query(
        "delete from pgboss.job j where j.name='message.send' and not exists(select 1 from tasks t where t.id::text=j.data->>'taskId')",
      );
      const conversationId = await ensureContactConversation(contact.id);
      const input = {
        conversationId,
        body: 'Synthetic message only',
        requestId: randomUUID(),
        socialDelivery: 'browser' as const,
      };
      const message = await queueConversationReply(input, user);
      messageId = message.id;
      expect(await queueConversationReply(input, user)).toEqual(message);
      expect(message.status).toBe('queued');
      const {
        rows: [task],
      } = await sonarPool.query(
        "select id,status from tasks where type='message.send' and payload->>'messageId'=$1",
        [messageId],
      );
      expect(task.status).toBe('queued');
      await registerEmailTasks();
      await vi.waitFor(
        async () => {
          const {
            rows: [state],
          } = await sonarPool.query('select status from tasks where id=$1', [
            task.id,
          ]);
          expect(state.status).toBe('done');
        },
        { timeout: 10000, interval: 100 },
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        id: account,
        channel: 'instagram',
      });
      expect(
        (
          await sonarPool.query(
            'select status,provider_id,first_attempt_at from messages where id=$1',
            [messageId],
          )
        ).rows[0],
      ).toEqual({
        status: 'sent',
        provider_id: 'synthetic-provider-id',
        first_attempt_at: expect.any(Date),
      });
    } finally {
      await boss.stop({ graceful: true, timeout: 10000 });
      await sonarPool.query(
        "delete from pgboss.job where name='message.send' and data->>'taskId' in (select id::text from tasks where payload->>'messageId'=$1)",
        [messageId ?? null],
      );
      await sonarPool.query(
        "delete from tasks where type='message.send' and payload->>'messageId'=$1",
        [messageId ?? null],
      );
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        company,
      ]);
      await sonarPool.query(
        'delete from messages where conversation_id in(select id from conversations where company_id=$1)',
        [company],
      );
      await sonarPool.query('delete from conversations where company_id=$1', [
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
    }
  },
  20000,
);
afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('@sonar/db/tasks');
  await closeTaskQueue();
  const { sonarPool, registryPool } = await import('@sonar/db');
  await Promise.all([sonarPool.end(), registryPool.end()]);
});
