import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'), email: typeof import('./email.js');
let inbound: typeof import('./inbound.js'), admin: import('pg-boss').PgBoss;
let TaskFailure: typeof import('./tasks.js').TaskFailure;
let viber: typeof import('./viber.js');
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  email = await import('./email.js');
  inbound = await import('./inbound.js');
  viber = await import('./viber.js');
  ({ TaskFailure } = await import('./tasks.js'));
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('message.send');
  await admin.createQueue('ai.inbound');
});

it.skipIf(!enabled)(
  'assigns an unowned Viber account explicitly to the CRM owner only',
  async () => {
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const {
      rows: [account],
    } = await db.sonarPool.query<{
      id: string;
      owner_id: string | null;
    }>(
      "select id,owner_id from channel_accounts where channel='viber' limit 1",
    );
    expect(account).toBeTruthy();
    const originalOwner = account!.owner_id;
    try {
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash,created_at) values($1,$2,'Viber CRM owner','stub','1970-01-01'),($3,$4,'Other user','stub','1970-01-02')",
        [
          ownerId,
          `${ownerId}@invalid.test`,
          otherId,
          `${otherId}@invalid.test`,
        ],
      );
      await db.sonarPool.query(
        'update channel_accounts set owner_id=null where id=$1',
        [account!.id],
      );
      await expect(viber.claimViberAccount(otherId)).rejects.toThrow(
        'Лише власник CRM може призначити власника каналу Viber.',
      );
      await expect(viber.claimViberAccount(ownerId)).resolves.toMatchObject({
        id: account!.id,
        ownerId,
      });
      await expect(viber.claimViberAccount(otherId)).rejects.toThrow(
        'Канал Viber доступний лише призначеному власнику.',
      );
      await expect(
        viber.updateViberAccount(otherId, { dailyLimit: 20 }),
      ).rejects.toThrow('Канал Viber доступний лише призначеному власнику.');
      const {
        rows: [assigned],
      } = await db.sonarPool.query<{ owner_id: string }>(
        'select owner_id from channel_accounts where id=$1',
        [account!.id],
      );
      expect(assigned?.owner_id).toBe(ownerId);
    } finally {
      await db.sonarPool.query(
        'update channel_accounts set owner_id=$2 where id=$1',
        [account!.id, originalOwner],
      );
      await db.sonarPool.query(
        'delete from activity_log where user_id=any($1::uuid[]) and entity_id=$2',
        [[ownerId, otherId], account!.id],
      );
      await db.sonarPool.query('delete from users where id=any($1::uuid[])', [
        [ownerId, otherId],
      ]);
    }
  },
);

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
      const timeoutMessage = await email.createCompanyMessage(
        {
          channel: 'viber',
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: account.id,
          toAddress: '+48500100200',
          body: 'Stub timeout Viber fixture',
          submit: true,
          idempotencyKey: randomUUID(),
        },
        ids.user,
      );
      const timeoutReason =
        'Міст Viber не відповів за 240 с. Перевірте з’єднання з Viber Desktop і повторіть завдання.';
      expect(
        await email.sendEmailMessage(
          timeoutMessage.id,
          randomUUID(),
          async () => {
            throw new TaskFailure('viber_bridge_timeout', timeoutReason);
          },
          new Date('2026-11-18T10:00:00Z'),
          () => 0,
          'viber',
        ),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'viber_delivery_uncertain',
        reasonUk: timeoutReason,
      });
      expect(
        (
          await db.sonarPool.query(
            'select reason_uk from messages where id=$1',
            [timeoutMessage.id],
          )
        ).rows[0].reason_uk,
      ).toBe(timeoutReason);
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
      const received = await inbound.recordInbound(incoming);
      expect(received).toMatchObject({
        created: true,
        companyId: ids.company,
      });
      expect(await inbound.recordInbound(incoming)).toMatchObject({
        created: false,
        companyId: ids.company,
      });
      const replyRequest = {
        conversationId: received.conversationId,
        body: 'Viber inbox reply',
        requestId: randomUUID(),
      };
      const reply = await inbound.queueConversationReply(
        replyRequest,
        ids.user,
      );
      expect(reply).toMatchObject({ status: 'queued' });
      expect(
        await inbound.queueConversationReply(replyRequest, ids.user),
      ).toEqual(reply);
      expect(
        (
          await db.sonarPool.query(
            'select channel,account_id,to_value,source from messages where id=$1',
            [reply.id],
          )
        ).rows[0],
      ).toEqual({
        channel: 'viber',
        account_id: account.id,
        to_value: '+48500100200',
        source: 'reply',
      });
      await db.sonarPool.query(
        "insert into do_not_contact(company_id,kind,value_normalized,reason,created_by) values($1::uuid,'company',$1::text,'Viber refusal',$2::uuid)",
        [ids.company, ids.user],
      );
      await expect(
        inbound.queueConversationReply(
          { ...replyRequest, requestId: randomUUID() },
          ids.user,
        ),
      ).rejects.toThrow('Контакт у списку «Не контактувати».');
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1 or created_by=$2',
        [ids.company, ids.user],
      );
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

      const now = new Date();
      async function failedAttempt(
        body: string,
        minutes = 10,
        reason = 'viber_delivery_uncertain',
        attemptedAt = new Date(now.getTime() - minutes * 60_000),
      ) {
        const message = await email.createCompanyMessage(
          {
            channel: 'viber',
            companyId: ids.company,
            campaignId: ids.campaign,
            accountId: account.id,
            toAddress: '+48500100200',
            body,
            submit: true,
            idempotencyKey: randomUUID(),
          },
          ids.user,
        );
        await db.sonarPool.query(
          `update messages set status='failed',created_at=$2::timestamptz-interval '1 day',
            first_attempt_at=$3,
            request_snapshot=jsonb_build_object('to',to_value,'body',body,'idempotencyKey',idempotency_key)
            where id=$1`,
          [message.id, now, attemptedAt],
        );
        await db.sonarPool.query(
          "update tasks set status='paused',reason_code=$2 where type='message.send' and payload->>'messageId'=$1",
          [message.id, reason],
        );
        return message;
      }
      const uncertain = await failedAttempt('Observed outgoing Viber fixture');
      const manual = await email.createCompanyMessage(
        {
          channel: 'viber',
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: account.id,
          toAddress: '+48500100200',
          body: 'Manually confirmed Viber fixture',
          submit: true,
          idempotencyKey: randomUUID(),
        },
        ids.user,
      );
      const attemptedAt = new Date(Date.now() - 2000);
      await db.sonarPool.query(
        "update messages set status='failed',first_attempt_at=$2,reason_uk='confirmation uncertain' where id=any($1::uuid[])",
        [[manual.id], attemptedAt],
      );
      const { reconcileViberDeliveries, markViberSentManually } =
        await import('./viber.js');
      const observedAt = new Date(now.getTime() - 1000).toISOString();
      const observed = (
        text: string,
        providerMessageId = randomUUID(),
        at = observedAt,
      ) => ({
        from: '+48500100200',
        text,
        at,
        providerMessageId,
      });
      expect(
        await reconcileViberDeliveries(
          [observed('Observed outgoing Viber fixture')],
          now,
          randomUUID(),
        ),
      ).toBe(0);
      expect(
        await reconcileViberDeliveries(
          [
            {
              ...observed('Observed outgoing Viber fixture'),
              from: '+48500999999',
            },
          ],
          now,
          account.id,
        ),
      ).toBe(0);
      expect(
        await reconcileViberDeliveries(
          [
            {
              from: '+48500100200',
              text: 'Observed outgoing Viber fixture',
              at: observedAt,
              providerMessageId: 'screen-outgoing-fixture',
            },
          ],
          now,
          account.id,
        ),
      ).toBe(1);
      const reconciled = await db.sonarPool.query(
        'select status,provider_id,sent_at from messages where id=$1',
        [uncertain.id],
      );
      expect(reconciled.rows[0]).toMatchObject({
        status: 'sent',
        provider_id: 'screen-outgoing-fixture',
      });
      for (const [body, text, minutes, reason, at] of [
        ['Too old', 'Too old', 31, 'viber_delivery_uncertain', observedAt],
        ['Not uncertain', 'Not uncertain', 10, 'do_not_contact', observedAt],
        [
          'Before attempt',
          'Before attempt',
          10,
          'viber_delivery_uncertain',
          new Date(now.getTime() - 11 * 60_000).toISOString(),
        ],
        ['👍', '👎', 10, 'viber_delivery_uncertain', observedAt],
        [
          'Identical prefix '.repeat(8) + 'one',
          'Identical prefix '.repeat(8) + 'two',
          10,
          'viber_delivery_uncertain',
          observedAt,
        ],
      ] as const) {
        await failedAttempt(body, minutes, reason);
        expect(
          await reconcileViberDeliveries(
            [observed(text, randomUUID(), at)],
            now,
            account.id,
          ),
        ).toBe(0);
      }
      const screenAt = new Date(
        Math.floor((now.getTime() - 10 * 60_000) / 60_000) * 60_000,
      ).toISOString();
      await failedAttempt(
        'Same minute',
        10,
        'viber_delivery_uncertain',
        new Date(new Date(screenAt).getTime() + 30_000),
      );
      expect(
        await reconcileViberDeliveries(
          [observed('Same minute', 'screen:old-minute', screenAt)],
          now,
          account.id,
        ),
      ).toBe(0);
      const changed = await failedAttempt('Original attempt body');
      await expect(
        db.sonarPool.query(
          "update messages set body='Edited body' where id=$1",
          [changed.id],
        ),
      ).rejects.toThrow('Message request is immutable after first attempt');
      expect(
        await reconcileViberDeliveries(
          [observed('Edited body')],
          now,
          account.id,
        ),
      ).toBe(0);
      await failedAttempt('Repeated identical body');
      await failedAttempt('Repeated identical body');
      const repeated = observed('Repeated identical body');
      expect(
        await reconcileViberDeliveries([repeated, repeated], now, account.id),
      ).toBe(1);
      expect(await reconcileViberDeliveries([repeated], now, account.id)).toBe(
        0,
      );
      expect(
        await reconcileViberDeliveries(
          [observed('Repeated identical body')],
          now,
          account.id,
        ),
      ).toBe(1);
      const {
        rows: [manualRow],
      } = await db.sonarPool.query<{ conversation_id: string }>(
        'select conversation_id from messages where id=$1',
        [manual.id],
      );
      expect(
        await markViberSentManually(
          manual.id,
          manualRow!.conversation_id,
          ids.user,
        ),
      ).toMatchObject({ status: 'sent' });
      const activity = await db.sonarPool.query(
        "select user_id,action from activity_log where entity_id=$1 and action='viber.manually_sent'",
        [ids.company],
      );
      expect(activity.rows).toContainEqual({
        user_id: ids.user,
        action: 'viber.manually_sent',
      });
    } finally {
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1 or created_by=$2',
        [ids.company, ids.user],
      );
      await db.sonarPool.query(
        "delete from pgboss.job where name='message.send' and data->>'taskId' in (select id::text from tasks where payload->>'messageId' in (select id::text from messages where conversation_id in (select id from conversations where company_id=$1)))",
        [ids.company],
      );
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in (select id::text from messages where conversation_id in (select id from conversations where company_id=$1))",
        [ids.company],
      );
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
