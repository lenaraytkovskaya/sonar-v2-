import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  encryptTelegramSession,
  TelegramSendError,
} from '@sonar/core/telegram';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'),
  email: typeof import('./email.js'),
  telegram: typeof import('./telegram.js');
let admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  email = await import('./email.js');
  telegram = await import('./telegram.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('message.send');
});
it.skipIf(!enabled)(
  'encrypts owner-bound expiring login, handles 2FA and serializes logout',
  async () => {
    const user = randomUUID(),
      other = randomUUID(),
      previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'telegram-test-secret-at-least-32-characters';
    const adapter = {
      startLogin: vi.fn(async () => ({
        session: 'pending-session',
        phoneCodeHash: 'private-hash',
      })),
      finishLogin: vi.fn(
        async (input: { code?: string; password?: string }) => {
          if (input.code === 'bad')
            throw new TelegramSendError('invalid_code', 'Код неправильний.');
          return {
            session: input.password ? 'authorized-session' : '2fa-session',
            requiresPassword: !input.password,
          };
        },
      ),
      logout: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    try {
      for (const id of [user, other])
        await db.sonarPool.query(
          "insert into users(id,email,name,password_hash) values($1,$2,'Telegram test','stub')",
          [id, `${id}@invalid.test`],
        );
      const now = new Date(),
        pending = await telegram.beginTelegramLogin(
          { name: 'Telegram test', phone: '+380501234567', dailyLimit: 10 },
          user,
          adapter,
          now,
        );
      const settings = (
        await db.sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [pending.id],
        )
      ).rows[0].settings;
      expect(JSON.stringify(settings)).not.toContain('pending-session');
      expect(JSON.stringify(settings)).not.toContain('private-hash');
      await expect(
        telegram.completeTelegramLogin(
          pending.id,
          { code: '12345' },
          other,
          adapter,
          now,
        ),
      ).rejects.toThrow('не знайдено');
      await expect(
        telegram.completeTelegramLogin(
          pending.id,
          { code: 'bad' },
          user,
          adapter,
          now,
        ),
      ).rejects.toThrow('Код неправильний');
      expect(
        await telegram.completeTelegramLogin(
          pending.id,
          { code: '12345' },
          user,
          adapter,
          now,
        ),
      ).toMatchObject({ step: 'password' });
      expect(
        await telegram.completeTelegramLogin(
          pending.id,
          { password: 'private-password' },
          user,
          adapter,
          now,
        ),
      ).toMatchObject({ step: 'done' });
      const account = (await telegram.listTelegramAccounts()).find(
        (a) => a.id === pending.id,
      )!;
      expect(account.enabled).toBe(true);
      expect(account.fullAddress).toBe('+380501234567');
      expect(account.address).not.toContain('501234');
      expect(account).not.toHaveProperty('settings');
      expect(
        await telegram.updateTelegramAccount(
          pending.id,
          { dailyLimit: 2 },
          user,
        ),
      ).toBe(true);
      expect(
        await telegram.updateTelegramAccount(
          pending.id,
          { enabled: false },
          user,
        ),
      ).toBe(true);
      expect(
        await telegram.logoutTelegramAccount(pending.id, user, adapter),
      ).toBe(true);
      expect(adapter.logout).toHaveBeenCalledWith('authorized-session');
      expect(
        (
          await db.sonarPool.query(
            'select settings from channel_accounts where id=$1',
            [pending.id],
          )
        ).rows[0].settings,
      ).toEqual({});
      const expired = await telegram.beginTelegramLogin(
        { name: 'Expired', phone: '+380501234567', dailyLimit: 1 },
        user,
        adapter,
        now,
      );
      await expect(
        telegram.completeTelegramLogin(
          expired.id,
          { code: '12345' },
          user,
          adapter,
          new Date(now.getTime() + 600001),
        ),
      ).rejects.toThrow('закінчився');
    } finally {
      process.env.AUTH_SECRET = previous;
      await db.sonarPool.query(
        'delete from activity_log where user_id=any($1::uuid[])',
        [[user, other]],
      );
      await db.sonarPool.query(
        'delete from channel_accounts where owner_id=any($1::uuid[])',
        [[user, other]],
      );
      await db.sonarPool.query('delete from users where id=any($1::uuid[])', [
        [user, other],
      ]);
    }
  },
);
it.skipIf(!enabled)(
  'shares send guards, defers FLOOD_WAIT, tags exact unavailable recipients and pauses ambiguous attempts',
  async () => {
    const ids = {
      user: randomUUID(),
      account: randomUUID(),
      campaign: randomUUID(),
      batch: randomUUID(),
      company: randomUUID(),
    };
    const now = new Date('2026-11-12T10:00:00Z'),
      previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'telegram-test-secret-at-least-32-characters';
    const keys = [
      'send.hours',
      'send.time_zones',
      'send.min_gap_seconds',
      'send.max_gap_seconds',
    ];
    const original = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    const create = (to = '@first_recipient') =>
      email.createCompanyMessage(
        {
          channel: 'telegram',
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: ids.account,
          toAddress: to,
          body: 'Test only',
          submit: true,
          idempotencyKey: randomUUID(),
        },
        ids.user,
      );
    const send = (
      id: string,
      sender: import('./email.js').ChannelSender,
      at = now,
    ) =>
      email.sendEmailMessage(id, randomUUID(), sender, at, () => 0, 'telegram');
    try {
      for (const [key, value] of [
        ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
        ['send.time_zones', { PL: 'Europe/Warsaw' }],
        ['send.min_gap_seconds', 0],
        ['send.max_gap_seconds', 0],
      ])
        await db.sonarPool.query(
          'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
          [key, JSON.stringify(value)],
        );
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Telegram test','stub')",
        [ids.user, `${ids.user}@invalid.test`],
      );
      await db.sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Telegram test','PL','uk','{}','{}','test',1,'{"telegram":true}','{}','auto','active')`,
        [ids.campaign],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [ids.batch, ids.campaign, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,country_code) values($1,$2,'Telegram test','ready','PL')",
        [ids.company, ids.company],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [ids.campaign, ids.company, ids.batch],
      );
      for (const to of ['https://t.me/first_recipient', '@second_recipient'])
        await db.sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source) values($1,'telegram',$2,$2,'manual')",
          [ids.company, to],
        );
      await db.sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,daily_limit,owner_id,settings) values($1,'telegram','Telegram test','+380501234567',10,$2,$3)",
        [
          ids.account,
          ids.user,
          JSON.stringify({
            sessionEncrypted: encryptTelegramSession(
              'authorized-session',
              process.env.AUTH_SECRET!,
            ),
          }),
        ],
      );
      const sender = vi.fn(async () => 'provider-telegram'),
        one = await create();
      await Promise.all([send(one.id, sender), send(one.id, sender)]);
      expect(sender).toHaveBeenCalledTimes(1);
      const sent = (
        await db.sonarPool.query('select * from messages where id=$1', [one.id])
      ).rows[0];
      expect(sent.provider_id).toBe('provider-telegram');
      expect(JSON.stringify(sent.request_snapshot)).not.toContain(
        'authorized-session',
      );
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=1 where id=$1',
        [ids.account],
      );
      const limited = await create();
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      expect(sender).toHaveBeenCalledTimes(1);
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=100 where id=$1',
        [ids.account],
      );
      await db.sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 12, end: 13, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      expect(sender).toHaveBeenCalledTimes(1);
      await db.sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      const wait = await create(),
        flood = vi.fn(async () => {
          throw new TelegramSendError('flood_wait', 'Пауза Telegram', true, 60);
        });
      expect(await send(wait.id, flood)).toMatchObject({
        status: 'deferred',
        runAt: new Date(now.getTime() + 60000),
      });
      expect(await send(wait.id, sender)).toMatchObject({ status: 'deferred' });
      expect(
        await send(wait.id, sender, new Date(now.getTime() + 60000)),
      ).toMatchObject({ status: 'done' });
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null where id=$1',
        [ids.account],
      );
      const uncertainRetry = await create();
      expect(await send(uncertainRetry.id, flood)).toMatchObject({
        status: 'deferred',
      });
      const retrySender = vi.fn(async () => {
        expect(
          (
            await db.sonarPool.query(
              'select reason_uk from messages where id=$1',
              [uncertainRetry.id],
            )
          ).rows[0].reason_uk,
        ).toBeNull();
        throw Error('unknown outcome after flood retry');
      });
      expect(
        await send(
          uncertainRetry.id,
          retrySender,
          new Date(now.getTime() + 60000),
        ),
      ).toMatchObject({ status: 'paused' });
      expect(
        await send(
          uncertainRetry.id,
          retrySender,
          new Date(now.getTime() + 60000),
        ),
      ).toMatchObject({ status: 'paused' });
      expect(retrySender).toHaveBeenCalledTimes(1);
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null where id=$1',
        [ids.account],
      );
      const cleanup = await create(),
        cleanupSender = vi.fn(async () => {
          throw Object.assign(
            new TelegramSendError(
              'cleanup_failed',
              'Повідомлення надіслано, видаліть контакт вручну.',
            ),
            {
              providerMessageId: 'confirmed-with-cleanup',
              accountRetryAfterSeconds: 90,
            },
          );
        });
      expect(await send(cleanup.id, cleanupSender)).toMatchObject({
        status: 'done',
        result: { providerId: 'confirmed-with-cleanup' },
      });
      expect(await send(cleanup.id, cleanupSender)).toMatchObject({
        status: 'done',
      });
      expect(cleanupSender).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.sonarPool.query(
            'select status,provider_id,reason_uk from messages where id=$1',
            [cleanup.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'sent',
        provider_id: 'confirmed-with-cleanup',
        reason_uk: 'Повідомлення надіслано, видаліть контакт вручну.',
      });
      expect(
        (
          await db.sonarPool.query(
            'select next_send_at from channel_accounts where id=$1',
            [ids.account],
          )
        ).rows[0].next_send_at,
      ).toEqual(new Date(now.getTime() + 90000));
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null where id=$1',
        [ids.account],
      );
      const unknown = await create(),
        failure = vi.fn(async () => {
          throw Error('private-session-must-not-leak');
        });
      expect(await send(unknown.id, failure)).toMatchObject({
        status: 'paused',
      });
      expect(await send(unknown.id, failure)).toMatchObject({
        status: 'paused',
      });
      expect(failure).toHaveBeenCalledTimes(1);
      const unavailable = await create();
      await create('@second_recipient');
      expect(
        await send(unavailable.id, async () => {
          throw new TelegramSendError(
            'unavailable',
            'Telegram недоступний.',
            false,
            undefined,
            true,
          );
        }),
      ).toMatchObject({ status: 'failed' });
      const contacts = (
        await db.sonarPool.query(
          'select normalized,meta from contacts where company_id=$1',
          [ids.company],
        )
      ).rows;
      expect(
        contacts.find((r) => r.normalized.includes('first_recipient')).meta
          .telegram_unavailable,
      ).toMatchObject({ reason_uk: 'Telegram недоступний.' });
      expect(
        contacts.find((r) => r.normalized.includes('second_recipient')).meta,
      ).not.toHaveProperty('telegram_unavailable');
      await expect(create()).rejects.toThrow('контактів');
      const dnc = await create('@second_recipient');
      await email.blockCompany(ids.company, ids.user);
      expect(await send(dnc.id, sender)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
    } finally {
      process.env.AUTH_SECRET = previous;
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
        'delete from do_not_contact where company_id=$1',
        [ids.company],
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
