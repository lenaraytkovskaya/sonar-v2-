import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { campaignSchema } from '@sonar/core';
import {
  encryptSocialStorageState,
  socialProxyFingerprint,
} from '@sonar/core/social-session';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./social-send-browser.js', () => ({
  socialSendBrowser: { send, close: vi.fn() },
}));

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled).each(['instagram', 'facebook'] as const)(
  'dispatches a human %s reply through pg-boss and yields Facebook import before sending',
  async (network) => {
    send.mockReset();
    vi.stubEnv(
      'AUTH_SECRET',
      'worker-social-send-isolated-test-secret-over-32',
    );
    vi.stubEnv('SOCIAL_PROXY_URLS', 'http://worker-social-send.invalid:8000');
    const sessionSettings = {
      sessionStatus: 'valid',
      inboxPollingEnabled: true,
      proxyIndex: 0,
      proxyFingerprint: socialProxyFingerprint({
        server: 'http://worker-social-send.invalid:8000',
      }),
      storageStateEncrypted: encryptSocialStorageState(
        JSON.stringify({
          cookies: [
            {
              name: network === 'facebook' ? 'c_user' : 'sessionid',
              value: network === 'facebook' ? '100000000000002' : 'stub',
              domain: `.${network}.com`,
              session: true,
            },
          ],
          origins: [
            {
              origin: `https://www.${network}.com`,
              localStorage: [{ name: 'synthetic', value: 'stub' }],
            },
          ],
        }),
        network,
        process.env.AUTH_SECRET!,
      ),
    };
    const { sonarPool } = await import('@sonar/db');
    const { boss } = await import('@sonar/db/tasks');
    const { ensureContactConversation, queueConversationReply } =
      await import('@sonar/db/inbound');
    const { registerEmailTasks } = await import('./email.js');
    const user = randomUUID(),
      company = randomUUID(),
      campaign = randomUUID(),
      account = randomUUID();
    const keys = [
      'send.hours',
      'send.time_zones',
      'social.inbox.enabled',
      'social.inbox.facebook.enabled',
      'social.inbox.daily_limit',
    ];
    const original = (
      await sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    let messageId: string | undefined;
    let syncTaskId: string | undefined;
    const events: string[] = [];
    let queued!: () => void;
    const queuedReply = new Promise<void>((resolve) => {
      queued = resolve;
    });
    let entered!: () => void;
    const importEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sendStarted = 0;
    let sentAt = 0;
    try {
      await sonarPool.query(
        "update settings set value=$1 where key='send.hours'",
        [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
      );
      await sonarPool.query(
        "update settings set value=$1 where key='send.time_zones'",
        [JSON.stringify({ PL: 'UTC' })],
      );
      if (network === 'facebook')
        await sonarPool.query(
          "update settings set value=case when key='social.inbox.daily_limit' then '1'::jsonb else 'true'::jsonb end where key=any($1::text[])",
          [
            [
              'social.inbox.enabled',
              'social.inbox.facebook.enabled',
              'social.inbox.daily_limit',
            ],
          ],
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
        [
          company,
          `https://www.${network}.com/${network === 'facebook' ? '100000000000003' : 'synthetic_test'}/`,
        ],
      );
      await sonarPool.query(
        `insert into channel_accounts(id,channel,name,address,daily_limit,settings)
         values($1,$3,'Synthetic worker test','synthetic',20,$2)`,
        [account, sessionSettings, network],
      );
      // Only this fake transport is reachable; no browser or social credentials.
      send.mockImplementation(async (...args: unknown[]) => {
        const beforeSend = args[5] as () => Promise<void>;
        await beforeSend();
        events.push('send');
        sentAt = Date.now();
        return network === 'instagram'
          ? 'synthetic-provider-id'
          : {
              outcome: 'facebook_dispatched_unconfirmed',
              dialogUrl: 'https://www.facebook.com/100000000000003/',
              observation: {
                inputExactMatch: true,
                dispatchPerformed: true,
                outgoingBefore: 0,
                outgoingAfter: 1,
                newOutgoing: true,
                observationMs: 1,
                lateError: 'none',
              },
            };
      });
      await boss.start();
      await boss.createQueue('message.send');
      // Other DB tests call handlers directly and remove tasks, leaving orphan jobs.
      await sonarPool.query(
        "delete from pgboss.job j where j.name='message.send' and not exists(select 1 from tasks t where t.id::text=j.data->>'taskId')",
      );
      if (network === 'facebook') {
        const { runTask, enqueueTask } = await import('@sonar/db/tasks');
        const { runSocialInboxSync } = await import('./social-inbox.js');
        await boss.createQueue('social.inbox.sync');
        let pass = 0;
        await runTask('social.inbox.sync', (payload, taskId) =>
          runSocialInboxSync(
            payload as { accountId: string },
            {
              sync: async (_account, checkpoint, persist) => {
                if (pass++ === 0) {
                  events.push('import:first');
                  entered();
                  await queuedReply;
                  await vi.waitFor(
                    async () => {
                      expect(
                        (
                          await sonarPool.query(
                            "select reason_code from tasks where type='message.send' and payload->>'messageId'=$1",
                            [messageId],
                          )
                        ).rows[0]?.reason_code,
                      ).toBe('social_profile_busy');
                    },
                    { timeout: 10_000 },
                  );
                  await persist({
                    messages: [],
                    resumeAnchor: { nextThreadUrl: '/messages/t/200/' },
                  });
                  throw Error('Priority should yield after persistence');
                }
                expect(checkpoint.resumeAnchor).toEqual({
                  nextThreadUrl: '/messages/t/200/',
                });
                events.push('import:remaining');
                return { complete: true };
              },
            },
            new Date(),
            taskId,
          ),
        );
        syncTaskId = (await enqueueTask('social.inbox.sync', randomUUID(), {
          accountId: account,
        }))!;
        await importEntered;
      }
      const conversationId = await ensureContactConversation(contact.id);
      const input = {
        conversationId,
        body: 'Synthetic message only',
        requestId: randomUUID(),
        socialDelivery: 'browser' as const,
      };
      sendStarted = Date.now();
      const message = await queueConversationReply(input, user);
      messageId = message.id;
      queued();
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
        channel: network,
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
        provider_id:
          network === 'instagram'
            ? 'synthetic-provider-id'
            : 'https://www.facebook.com/100000000000003/',
        first_attempt_at: expect.any(Date),
      });
      if (network === 'facebook') {
        await vi.waitFor(
          async () =>
            expect(
              (
                await sonarPool.query('select status from tasks where id=$1', [
                  syncTaskId,
                ])
              ).rows[0]?.status,
            ).toBe('done'),
          { timeout: 10_000 },
        );
        expect(events).toEqual(['import:first', 'send', 'import:remaining']);
        expect(sentAt - sendStarted).toBeLessThan(20_000);
        expect(
          (
            await sonarPool.query(
              "select settings->'socialAction'->'counts'->>'sync' as n from channel_accounts where id=$1",
              [account],
            )
          ).rows[0]?.n,
        ).toBe('1');
      }
    } finally {
      queued();
      await boss.stop({ graceful: true, timeout: 10000 });
      if (syncTaskId) {
        await sonarPool.query(
          "delete from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1",
          [syncTaskId],
        );
        await sonarPool.query('delete from tasks where id=$1', [syncTaskId]);
      }
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
      vi.unstubAllEnvs();
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
