import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import {
  SocialSendError,
  encryptSocialCookies,
  socialProxyFingerprint,
  facebookDispatchReason,
  type FacebookDispatchResult,
  SocialSessionCheckError,
} from '@sonar/core/social-session';
import { campaignSchema } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled).each(['instagram', 'facebook'] as const)(
  'queues only human %s replies and guards durable attempts, limits, sessions and refusals',
  async (network) => {
    const originalSecret = process.env.AUTH_SECRET;
    const originalProxies = process.env.SOCIAL_PROXY_URLS;
    process.env.AUTH_SECRET = 'social-send-isolated-test-secret-over-32';
    process.env.SOCIAL_PROXY_URLS = 'http://social-send.invalid:8000';
    const sessionSettings = {
      sessionStatus: 'valid',
      proxyIndex: 0,
      proxyFingerprint: socialProxyFingerprint({
        server: 'http://social-send.invalid:8000',
      }),
      cookiesEncrypted: encryptSocialCookies(
        JSON.stringify([
          {
            name: 'sid',
            value: 'stub',
            domain: `.${network}.com`,
            session: true,
          },
        ]),
        network,
        process.env.AUTH_SECRET,
      ),
    };
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
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Social send','PL','uk','{}','{}','test',1,$2,'{}','auto','active')`,
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
        [company, `https://www.${network}.com/sonar_test/`],
      );
      await sonarPool.query(
        `insert into channel_accounts(id,channel,name,address,daily_limit,owner_id,settings) values($1,$3,'Social send',$3,20,$2,$4)`,
        [account, user, network, sessionSettings],
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
          "update channel_accounts set next_send_at=null,daily_limit=100,status='active',settings=$2 where id=$1",
          [account, sessionSettings],
        );
      const dispatch = (url: string): FacebookDispatchResult => ({
        outcome: 'facebook_dispatched_unconfirmed',
        dialogUrl: url,
        observation: {
          inputExactMatch: true,
          dispatchPerformed: true,
          outgoingBefore: 99,
          outgoingAfter: 99,
          newOutgoing: true,
          observationMs: 400,
          lateError: 'none',
        },
      });
      const sender = vi.fn(async (request, a) => {
        await a!.beforeSend!();
        return network === 'facebook'
          ? dispatch(request.to)
          : 'https://www.instagram.com/direct/t/123/';
      });
      const key = randomUUID(),
        first = await create(key);
      expect(await create(key)).toEqual(first);
      await expect(create(key, 'manual')).rejects.toThrow('Ключ повідомлення');
      await sonarPool.query(
        "update campaigns set status='paused' where id=$1",
        [campaign],
      );
      expect(await send(first.id, sender)).toMatchObject({
        status: 'paused',
        reasonCode: 'campaign_inactive',
      });
      expect(sender).not.toHaveBeenCalled();
      await sonarPool.query(
        "update campaigns set status='active' where id=$1",
        [campaign],
      );
      const holder = await sonarPool.connect();
      await holder.query(
        "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
        [account],
      );
      try {
        expect(await send(first.id, sender)).toMatchObject({
          status: 'deferred',
          reasonCode: 'social_profile_busy',
        });
        expect(sender).not.toHaveBeenCalled();
      } finally {
        await holder.query(
          "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
          [account],
        );
        holder.release();
      }
      expect(await send(first.id, sender)).toMatchObject({ status: 'done' });
      expect(sender).toHaveBeenCalledTimes(1);
      expect(await send(first.id, sender)).toMatchObject({ status: 'done' });
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
      const stored = (await getConversationChat(conversationId)).messages.find(
        (m) => m.id === first.id,
      )!;
      expect(stored.reasonUk).toBe(
        network === 'facebook' ? facebookDispatchReason : null,
      );
      if (network === 'instagram') {
        expect(
          (
            await sonarPool.query(
              'select provider_thread_id from conversations where id=$1',
              [conversationId],
            )
          ).rows[0].provider_thread_id,
        ).toBe('123');
        await reset();
        const nextReply = await create();
        const knownThreadSender = vi.fn(async (_request, a) => {
          expect(a?.settings.providerThreadId).toBe('123');
          await a!.beforeSend!();
          return 'https://www.instagram.com/direct/t/123/';
        });
        expect(await send(nextReply.id, knownThreadSender)).toMatchObject({
          status: 'done',
        });
        expect(knownThreadSender).toHaveBeenCalledOnce();
      }
      if (network === 'facebook') {
        expect(stored.providerId).toBe(`https://www.facebook.com/sonar_test/`);
        expect(await send(first.id, sender)).toMatchObject({
          status: 'done',
          result: { delivery: 'unconfirmed' },
        });
        expect(sender).toHaveBeenCalledOnce();
        for (const invalid of [
          'no_marker',
          'no_input',
          'no_dispatch',
          'no_outgoing',
        ] as const) {
          await reset();
          const message = await create();
          const invalidSender: import('./email.js').ChannelSender = async (
            request,
            a,
          ) => {
            if (invalid !== 'no_marker') await a!.beforeSend!();
            const result = dispatch(request.to);
            if (invalid === 'no_input')
              result.observation.inputExactMatch = false;
            if (invalid === 'no_dispatch')
              result.observation.dispatchPerformed = false;
            if (invalid === 'no_outgoing')
              result.observation.newOutgoing = false;
            return result;
          };
          expect(await send(message.id, invalidSender)).toMatchObject({
            status: 'paused',
            reasonCode: 'social_delivery_uncertain',
          });
          expect(
            (
              await sonarPool.query('select status from messages where id=$1', [
                message.id,
              ])
            ).rows[0].status,
          ).toBe('failed');
        }
        await reset();
        await sonarPool.query(
          'update channel_accounts set next_send_at=$2 where id=$1',
          [account, new Date(now.getTime() + 120000)],
        );
      }
      const limited = await create();
      expect(await send(limited.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      await sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 9, end: 18, days: [1, 2, 3, 4, 5] })],
      );
      expect(
        await send(limited.id, sender, new Date('2026-11-13T18:00:00Z')),
      ).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
        runAt: new Date('2026-11-16T08:00:00Z'),
      });
      await sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
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
      // Browser transport failures keep the session valid. After its durable
      // marker the adapter reports uncertainty, and the DB must never retry it.
      for (const attempted of [false, true]) {
        await reset();
        const message = await create();
        const transport = vi.fn(async (_request, a) => {
          if (attempted) {
            await a!.beforeSend!();
            throw new SocialSendError(
              'delivery_uncertain',
              'Перевірте чат вручну',
            );
          }
          throw new SocialSessionCheckError('network');
        });
        expect(await send(message.id, transport)).toMatchObject({
          status: 'paused',
          reasonCode: attempted
            ? 'social_delivery_uncertain'
            : 'social_session_network',
        });
        expect(
          (
            await sonarPool.query(
              'select status,settings from channel_accounts where id=$1',
              [account],
            )
          ).rows[0],
        ).toMatchObject({
          status: 'active',
          settings: { sessionStatus: 'valid' },
        });
        expect(
          (
            await sonarPool.query(
              'select status,first_attempt_at from messages where id=$1',
              [message.id],
            )
          ).rows[0],
        ).toEqual({
          status: attempted ? 'failed' : 'queued',
          first_attempt_at: attempted ? now : null,
        });
        if (attempted) {
          expect(await send(message.id, transport)).toMatchObject({
            status: 'paused',
            reasonCode: 'social_delivery_uncertain',
          });
          expect(transport).toHaveBeenCalledOnce();
        }
      }
      // Rate limits pause the account without invalidating cookies or retrying attempts.
      for (const attempted of [false, true]) {
        await reset();
        const limitedMessage = await create();
        const rateLimited = vi.fn(async (_request, a) => {
          if (attempted) await a!.beforeSend!();
          throw new SocialSendError(
            'rate_limit',
            '[session/http_429] Instagram обмежив частоту запитів.',
          );
        });
        expect(await send(limitedMessage.id, rateLimited)).toMatchObject({
          status: 'paused',
          reasonCode: 'account_health_paused',
        });
        expect(
          (
            await sonarPool.query(
              'select status,settings from channel_accounts where id=$1',
              [account],
            )
          ).rows[0],
        ).toMatchObject({
          status: 'paused',
          settings: { sessionStatus: 'valid' },
        });
        expect(
          (
            await sonarPool.query(
              'select status,first_attempt_at from messages where id=$1',
              [limitedMessage.id],
            )
          ).rows[0],
        ).toEqual({
          status: 'queued',
          first_attempt_at: attempted ? now : null,
        });
        expect(await send(limitedMessage.id, rateLimited)).toMatchObject({
          status: 'paused',
          reasonCode: 'account_health_paused',
        });
        if (attempted) {
          await reset();
          expect(await send(limitedMessage.id, rateLimited)).toMatchObject({
            status: 'paused',
            reasonCode: 'social_delivery_uncertain',
          });
        }
        expect(rateLimited).toHaveBeenCalledOnce();
      }
      await reset();
      const offline = await create();
      expect(
        await send(offline.id, async () => {
          throw new SocialSessionCheckError('login_required');
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
      const unavailable = await getConversationChat(conversationId);
      expect(unavailable.socialUnavailableReasonUk).toBeTruthy();
      const manualMark = await create(randomUUID(), 'manual');
      expect(manualMark.status).toBe('sent');
      expect(
        (await getConversationChat(conversationId)).messages.find(
          (m) => m.id === manualMark.id,
        ),
      ).toMatchObject({ status: 'sent', source: 'manual' });
      expect(
        (
          await sonarPool.query(
            'select account_id,source from messages where id=$1',
            [manualMark.id],
          )
        ).rows[0],
      ).toEqual({ account_id: null, source: 'manual' });
      await reset();
      const resumeMessages = [offline, await create(), await create()];
      for (const [message, reason] of resumeMessages.map(
        (message, index) =>
          [
            message,
            [
              'social_session_invalid',
              'social_session_timeout',
              'social_account_inactive',
            ][index],
          ] as const,
      )) {
        await sonarPool.query(
          "update tasks set status='paused',reason_code=$2,reason_uk='Перевірте сесію.' where type='message.send' and payload->>'messageId'=$1",
          [message.id, reason],
        );
        expect(
          (await getConversationChat(conversationId)).messages.find(
            (m) => m.id === message.id,
          ),
        ).toMatchObject({ status: 'paused', reasonUk: 'Перевірте сесію.' });
      }
      await sonarPool.query(
        'update channel_accounts set status=\'paused\',settings=settings||\'{"sessionStatus":"unconfirmed"}\'::jsonb where id=$1',
        [account],
      );
      const { withSocialSessionCheck } = await import('./social-accounts.js');
      expect(
        await withSocialSessionCheck(
          account,
          async () => ({ valid: true }),
          new Date(now.getTime() + 120000),
        ),
      ).toMatchObject({ status: 'done', result: { valid: true } });
      const { rows: resumed } = await sonarPool.query(
        "select payload->>'messageId' as id,status from tasks where type='message.send' and payload->>'messageId'=any($1::text[]) order by payload->>'messageId'",
        [resumeMessages.map((message) => message.id)],
      );
      expect(resumed).toHaveLength(3);
      expect(resumed.every((task) => task.status === 'queued')).toBe(true);
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
      const failedSend = await create();
      expect(
        await send(failedSend.id, async () => {
          throw Object.assign(
            new SocialSendError(
              'unavailable',
              'Поле повідомлення Instagram неоднозначне',
            ),
            { taskResult: { composer: { counts: { eligible: 2 } } } },
          );
        }),
      ).toMatchObject({
        status: 'skipped',
        result: { composer: { counts: { eligible: 2 } } },
      });
      await reset();
      const automatic = await create();
      await sonarPool.query(
        'update messages set created_by=null,approved_by=null where id=$1',
        [automatic.id],
      );
      const automaticSender = vi.fn();
      expect(await send(automatic.id, automaticSender)).toMatchObject({
        status: 'skipped',
        reasonCode: 'manual_submission_required',
      });
      expect(automaticSender).not.toHaveBeenCalled();
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
      if (originalSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = originalSecret;
      if (originalProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = originalProxies;
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
