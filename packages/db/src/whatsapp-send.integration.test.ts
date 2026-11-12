import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WhatsAppSendError } from '@sonar/core/whatsapp';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'), email: typeof import('./email.js');
let admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  // These suites exercise real sending logic; the owner's test-mode allowlist is covered in core.
  await (await import('./index.js')).sonarPool.query(
    "update settings set value='false' where key='send.test_mode'",
  );
  db = await import('./index.js');
  email = await import('./email.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('message.send');
});
it.skipIf(!enabled)(
  'guards WhatsApp sends, preserves safe retries and prevents ambiguous duplicate delivery',
  async () => {
    const ids = {
      user: randomUUID(),
      account: randomUUID(),
      campaign: randomUUID(),
      batch: randomUUID(),
      company: randomUUID(),
    };
    const now = new Date('2026-11-12T10:00:00Z');
    const keys = [
      'send.hours',
      'send.time_zones',
      'send.whatsapp.min_gap_seconds',
      'send.whatsapp.max_gap_seconds',
    ];
    const original = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    const create = (to = 'https://wa.me/48500100200', key = randomUUID()) =>
      email.createCompanyMessage(
        {
          channel: 'whatsapp',
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: ids.account,
          toAddress: to,
          body: 'Test only',
          submit: true,
          idempotencyKey: key,
        },
        ids.user,
      );
    const send = (
      id: string,
      sender: import('./email.js').ChannelSender,
      at = now,
    ) =>
      email.sendEmailMessage(id, randomUUID(), sender, at, () => 0, 'whatsapp');
    const reset = () =>
      db.sonarPool.query(
        "update channel_accounts set next_send_at=null,daily_limit=100,status='active' where id=$1",
        [ids.account],
      );
    try {
      for (const [key, value] of [
        ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
        ['send.time_zones', { PL: 'Europe/Warsaw' }],
        ['send.whatsapp.min_gap_seconds', 90],
        ['send.whatsapp.max_gap_seconds', 300],
      ])
        await db.sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'WhatsApp test','stub')",
        [ids.user, `${ids.user}@invalid.test`],
      );
      await db.sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'WhatsApp test','PL','uk','{}','{}','test',1,'{"whatsapp":true}','{}','auto','active')`,
        [ids.campaign],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [ids.batch, ids.campaign, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,country_code) values($1,$2,'WhatsApp test','ready','PL')",
        [ids.company, ids.company],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [ids.campaign, ids.company, ids.batch],
      );
      for (const [kind, to] of [
        ['whatsapp', 'https://wa.me/48500100200'],
        ['phone', '500100200'],
        ['phone', '+48500100201'],
      ])
        await db.sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source) values($1,$2,$3,$3,'manual')",
          [ids.company, kind, to],
        );
      await db.sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,daily_limit,owner_id) values($1,'whatsapp','WhatsApp test','+48500500500',10,$2)",
        [ids.account, ids.user],
      );
      const sender = vi.fn(async () => 'provider-whatsapp'),
        key = randomUUID(),
        one = await create(undefined, key);
      expect(await create('500100200', key)).toEqual(one);
      await Promise.all([send(one.id, sender), send(one.id, sender)]);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.sonarPool.query(
            'select provider_id,to_value from messages where id=$1',
            [one.id],
          )
        ).rows[0],
      ).toEqual({ provider_id: 'provider-whatsapp', to_value: '+48500100200' });
      expect(
        (
          await db.sonarPool.query(
            'select next_send_at from channel_accounts where id=$1',
            [ids.account],
          )
        ).rows[0].next_send_at,
      ).toEqual(new Date(now.getTime() + 90000));
      const limited = await create();
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null,daily_limit=1 where id=$1',
        [ids.account],
      );
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      await reset();
      await db.sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 12, end: 13, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      await db.sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      for (const code of ['waha_rate_limit', 'waha_server_error']) {
        await reset();
        const retry = await create(),
          failure = vi.fn(async () => {
            throw new WhatsAppSendError(
              code,
              'Тимчасова помилка WhatsApp.',
              true,
              120,
            );
          });
        expect(await send(retry.id, failure)).toMatchObject({
          status: 'deferred',
          runAt: new Date(now.getTime() + 120000),
        });
        expect(await send(retry.id, sender)).toMatchObject({
          status: 'deferred',
        });
        expect(
          await send(retry.id, sender, new Date(now.getTime() + 120000)),
        ).toMatchObject({ status: 'done' });
        expect(failure).toHaveBeenCalledTimes(1);
      }
      await reset();
      const offline = await create();
      expect(
        await send(offline.id, async () => {
          throw new WhatsAppSendError(
            'session_inactive',
            'Підключіть WhatsApp.',
            false,
            undefined,
            false,
            true,
          );
        }),
      ).toMatchObject({ status: 'paused' });
      expect(
        (
          await db.sonarPool.query(
            'select status from channel_accounts where id=$1',
            [ids.account],
          )
        ).rows[0].status,
      ).toBe('paused');
      expect(
        (
          await db.sonarPool.query(
            'select status,first_attempt_at,request_snapshot from messages where id=$1',
            [offline.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'queued',
        first_attempt_at: now,
        request_snapshot: { to: '+48500100200', body: 'Test only' },
      });
      await reset();
      expect(await send(offline.id, sender)).toMatchObject({ status: 'done' });
      await reset();
      const unknown = await create(),
        ambiguous = vi.fn(async () => {
          throw Error('private-token-must-not-leak');
        });
      expect(await send(unknown.id, ambiguous)).toMatchObject({
        status: 'paused',
      });
      await reset();
      expect(await send(unknown.id, ambiguous)).toMatchObject({
        status: 'paused',
      });
      expect(ambiguous).toHaveBeenCalledTimes(1);
      const bad = await create();
      expect(
        await send(bad.id, async () => {
          throw new WhatsAppSendError(
            'waha_rejected',
            'WhatsApp відхилив повідомлення.',
          );
        }),
      ).toMatchObject({ status: 'failed' });
      await reset();
      const unavailable = await create();
      expect(
        await send(unavailable.id, async () => {
          throw new WhatsAppSendError(
            'whatsapp_unavailable',
            'WhatsApp недоступний.',
            false,
            undefined,
            true,
          );
        }),
      ).toMatchObject({ status: 'skipped' });
      const contacts = (
        await db.sonarPool.query(
          'select normalized,meta from contacts where company_id=$1',
          [ids.company],
        )
      ).rows;
      expect(
        contacts
          .filter((r) => r.normalized !== '+48500100201')
          .every(
            (r) =>
              r.meta.whatsapp_unavailable?.reason_uk ===
              'WhatsApp недоступний.',
          ),
      ).toBe(true);
      expect(
        contacts.find((r) => r.normalized === '+48500100201').meta,
      ).not.toHaveProperty('whatsapp_unavailable');
      const messaging = await email.getCompanyMessaging(ids.company);
      expect(messaging.whatsappRecipients).toEqual(['+48500100201']);
      expect(messaging.whatsappUnavailable).toHaveLength(2);
      await expect(create()).rejects.toThrow('контактів');
      await reset();
      await db.sonarPool.query(
        "update campaigns set send_mode='approval' where id=$1",
        [ids.campaign],
      );
      const dnc = await create('+48500100201');
      expect(dnc.status).toBe('awaiting_approval');
      expect(await email.approveMessage(dnc.id, ids.user)).toBe(true);
      await db.sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason,created_by) values('whatsapp','https://wa.me/48500100201','Test refusal',$1)",
        [ids.user],
      );
      expect(await send(dnc.id, sender)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
      await expect(create('+48500100201')).rejects.toThrow('Не контактувати');
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1 or created_by=$2',
        [ids.company, ids.user],
      );
      await db.sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason,created_by) values('phone','500100201','Test refusal',$1)",
        [ids.user],
      );
      await expect(create('+48500100201')).rejects.toThrow('Не контактувати');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from spend_events where service_code='waha'",
            [],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.sonarPool.query('delete from tasks where subject_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from activity_log where user_id=$1 or entity_id=$2',
        [ids.user, ids.company],
      );
      await db.sonarPool.query('delete from messages where account_id=$1', [
        ids.account,
      ]);
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1 or created_by=$2',
        [ids.company, ids.user],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where campaign_id=$1',
        [ids.campaign],
      );
      await db.sonarPool.query('delete from batches where id=$1', [ids.batch]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        ids.campaign,
      ]);
      await db.sonarPool.query('delete from companies where id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        ids.account,
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
