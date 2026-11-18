import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'), email: typeof import('./email.js');
let inbound: typeof import('./inbound.js'), admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  email = await import('./email.js');
  inbound = await import('./inbound.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('message.send');
  await admin.createQueue('ai.inbound');
});

it.skipIf(!enabled)(
  'routes phone outreach and deduplicates Viber inbound on the shared channel path',
  async () => {
    const ids = {
      user: randomUUID(),
      campaign: randomUUID(),
      batch: randomUUID(),
      company: randomUUID(),
    };
    const account = (
      await db.sonarPool.query<{ id: string }>(
        "select id from channel_accounts where channel='viber' limit 1",
      )
    ).rows[0];
    expect(account).toBeTruthy();
    const keys = [
      'send.hours',
      'send.time_zones',
      'send.viber.min_gap_seconds',
      'send.viber.max_gap_seconds',
    ];
    const original = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    try {
      for (const [key, value] of [
        ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
        ['send.time_zones', { PL: 'Europe/Warsaw' }],
        ['send.viber.min_gap_seconds', 0],
        ['send.viber.max_gap_seconds', 0],
      ])
        await db.sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Viber test','stub')",
        [ids.user, `${ids.user}@invalid.test`],
      );
      await db.sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Viber test','PL','uk','{}','{}','test',1,'{"viber":true}','{}','auto','active')`,
        [ids.campaign],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [ids.batch, ids.campaign, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,country_code) values($1,$2,'Viber test','ready','PL')",
        [ids.company, ids.company],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [ids.campaign, ids.company, ids.batch],
      );
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'phone','+48500100200','+48500100200','manual')",
        [ids.company],
      );
      await db.sonarPool.query(
        "update channel_accounts set status='active',daily_limit=20 where id=$1",
        [account.id],
      );
      const draft = await db.sonarPool.query<{ id: string }>(
        'select id from contacts where company_id=$1',
        [ids.company],
      );
      const { selectOutreachContacts } = await import('@sonar/core');
      expect(
        selectOutreachContacts(
          [
            {
              id: draft.rows[0]!.id,
              kind: 'phone',
              normalized: '+48500100200',
              rank: 1,
            },
          ],
          { viber: true },
        ),
      ).toMatchObject([{ channel: 'viber' }]);
      const message = await email.createCompanyMessage(
        {
          channel: 'viber',
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: account.id,
          toAddress: '+48500100200',
          body: 'Stub only',
          submit: true,
          idempotencyKey: randomUUID(),
        },
        ids.user,
      );
      const sender = async () => 'stub-viber-message';
      expect(
        await email.sendEmailMessage(
          message.id,
          randomUUID(),
          sender,
          new Date('2026-11-18T10:00:00Z'),
          () => 0,
          'viber',
        ),
      ).toMatchObject({ status: 'done' });
      const receivedAt = new Date('2026-11-18T10:01:00Z');
      const incoming = {
        channel: 'viber' as const,
        accountId: account.id,
        providerId: 'fixture-viber-event-1',
        externalMessageId: 'fixture-viber-event-1',
        providerThreadId: 'fixture-viber-chat-1',
        sender: '+48500100200',
        body: 'Fixture reply',
        receivedAt,
      };
      expect(await inbound.recordInbound(incoming)).toMatchObject({
        created: true,
        companyId: ids.company,
      });
      expect(await inbound.recordInbound(incoming)).toMatchObject({
        created: false,
        companyId: ids.company,
      });
      const unbound = {
        ...incoming,
        providerId: 'fixture-viber-event-unbound',
        externalMessageId: 'fixture-viber-event-unbound',
        providerThreadId: 'fixture-viber-chat-unbound',
        sender: '',
      };
      const pending = await inbound.recordInbound(unbound);
      expect(pending).toMatchObject({ created: true, companyId: null });
      expect(await inbound.recordInbound(unbound)).toMatchObject({
        created: false,
        conversationId: pending.conversationId,
      });
      expect(
        await inbound.bindViberThread(
          pending.conversationId,
          ids.company,
          draft.rows[0]!.id,
          ids.user,
        ),
      ).toMatchObject({ companyId: ids.company });
    } finally {
      await db.sonarPool.query('delete from tasks where subject_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from activity_log where user_id=$1 or entity_id=$2',
        [ids.user, ids.company],
      );
      await db.sonarPool.query(
        'delete from messages where account_id=$1 and conversation_id in (select id from conversations where company_id=$2)',
        [account.id, ids.company],
      );
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from campaign_companies where campaign_id=$1',
        [ids.campaign],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from batches where id=$1', [ids.batch]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        ids.campaign,
      ]);
      await db.sonarPool.query('delete from companies where id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from users where id=$1', [ids.user]);
      await db.sonarPool.query(
        'delete from settings where key=any($1::text[])',
        [keys],
      );
      for (const row of original)
        await db.sonarPool.query(
          'insert into settings(key,value) values($1,$2)',
          [row.key, JSON.stringify(row.value)],
        );
    }
  },
);

afterAll(async () => {
  if (!enabled) return;
  await admin.stop();
  await (await import('./tasks.js')).closeTaskQueue();
  await db.sonarPool.end();
  await db.registryPool.end();
});
