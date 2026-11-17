import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  encryptSocialCookies,
  socialProxyFingerprint,
  SocialSessionCheckError,
  facebookDispatchReason,
} from '@sonar/core/social-session';
import type { SocialInboxMessage } from '@sonar/core/social-inbox';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('@sonar/db');
let inbox: typeof import('@sonar/db/social-inbox');
let worker: typeof import('../../../apps/worker/src/social-inbox.js');
let inbound: typeof import('@sonar/db/inbound');
let tasks: typeof import('@sonar/db/tasks');
let admin: import('pg-boss').PgBoss;
const account = randomUUID(),
  other = randomUUID(),
  company = randomUUID(),
  secondCompany = randomUUID(),
  user = randomUUID();
const peer = 'https://www.facebook.com/inbox_peer/';
const now = new Date('2026-11-14T10:00:00Z');
const originalSecret = process.env.AUTH_SECRET,
  originalProxies = process.env.SOCIAL_PROXY_URLS;
let originalSettings: { key: string; value: unknown }[] = [];
const message = (
  id: string,
  direction: 'in' | 'out' = 'in',
  profile = peer,
): SocialInboxMessage => ({
  externalMessageId: id,
  threadId: 'thread-' + profile,
  direction,
  senderProfile:
    direction === 'in' ? profile : 'https://www.facebook.com/own_account/',
  peerProfile: profile,
  body: 'Hello',
  occurredAt: '2026-11-14T09:00:00Z',
  observedAt: now.toISOString(),
});
const checkpoint = async () =>
  (
    await db.sonarPool.query(
      'select settings from channel_accounts where id=$1',
      [account],
    )
  ).rows[0].settings.inboxSync;
const resetGate = () =>
  db.sonarPool.query(
    "update channel_accounts set settings=(settings-'socialAction'-'healthPauseUntil')||'{\"healthAutoPaused\":false,\"reasonUk\":null,\"inboxPollingEnabled\":true}'::jsonb,status='active' where id=$1",
    [account],
  );
beforeAll(async () => {
  if (!enabled) return;
  process.env.AUTH_SECRET = 'isolated-social-inbox-test-secret-at-least-32';
  process.env.SOCIAL_PROXY_URLS = 'http://proxy.invalid:8000';
  db = await import('@sonar/db');
  inbox = await import('@sonar/db/social-inbox');
  worker = await import('../../../apps/worker/src/social-inbox.js');
  inbound = await import('@sonar/db/inbound');
  tasks = await import('@sonar/db/tasks');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const name of [
    'form.reply.match',
    'ai.inbound',
    'message.send',
    'social.inbox.sync',
  ])
    await admin.createQueue(name);
  originalSettings = (
    await db.sonarPool.query(
      "select key,value from settings where key in ('social.inbox.facebook.enabled','social.inbox.instagram.enabled','social.inbox.enabled','send.hours','send.time_zones')",
    )
  ).rows;
  await db.sonarPool.query(
    "update settings set value='true' where key in ('social.inbox.enabled','social.inbox.facebook.enabled','social.inbox.instagram.enabled')",
  );
  await db.sonarPool.query(
    "update settings set value=$1 where key='send.hours'",
    [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
  );
  await db.sonarPool.query(
    "update settings set value=$1 where key='send.time_zones'",
    [JSON.stringify({ PL: 'Europe/Warsaw' })],
  );
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'Inbox test','stub')",
    [user, `${user}@invalid.test`],
  );
  const cookies = encryptSocialCookies(
    JSON.stringify([
      {
        name: 'session',
        value: 'stub',
        domain: '.facebook.com',
        session: true,
      },
    ]),
    'facebook',
    process.env.AUTH_SECRET!,
  );
  for (const id of [other, account])
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','Inbox test','', 'active',20,$2)",
      [
        id,
        {
          sessionStatus: 'valid',
          inboxPollingEnabled: true,
          cookiesEncrypted: cookies,
          proxyIndex: 0,
          proxyFingerprint: socialProxyFingerprint({
            server: 'http://proxy.invalid:8000',
          }),
        },
      ],
    );
  for (const id of [company, secondCompany])
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::uuid::text,'Inbox test','PL')",
      [id],
    );
  await db.sonarPool.query(
    "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual')",
    [company, peer],
  );
});
it.skipIf(!enabled)(
  'authorizes and deduplicates manual Instagram imports without enabling or continuing polling',
  async () => {
    const accounts = await import('./social-accounts.js');
    const id = randomUUID();
    const previousPoll = '2026-11-13T10:03:00.000Z';
    const cookies = encryptSocialCookies(
      JSON.stringify([
        {
          name: 'sessionid',
          value: 'stub',
          domain: '.instagram.com',
          session: true,
        },
        {
          name: 'ds_user_id',
          value: '900000000000004',
          domain: '.instagram.com',
          session: true,
        },
      ]),
      'instagram',
      process.env.AUTH_SECRET!,
    );
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,settings) values($1,'instagram','Manual inbox test','',$2,'active',20,$3)",
      [
        id,
        user,
        {
          sessionStatus: 'valid',
          cookiesEncrypted: cookies,
          proxyIndex: 0,
          proxyFingerprint: socialProxyFingerprint({
            server: 'http://proxy.invalid:8000',
          }),
          inboxSync: {
            watermark: '2026-11-13T10:00:00.000Z',
            nextPollAt: previousPoll,
          },
        },
      ],
    );
    await db.sonarPool.query(
      "update settings set value='false' where key='social.inbox.enabled'",
    );
    const { parseInstagramInbox } =
      await import('../../../apps/worker/src/instagram-inbox-parser.js');
    const parsed = parseInstagramInbox(
      JSON.parse(
        readFileSync(
          new URL(
            '../../../apps/worker/src/instagram-inbox.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
      now.toISOString(),
    )!;
    const adapter = {
      sync: vi.fn<
        import('../../../apps/worker/src/social-inbox.js').SocialInboxAdapter['sync']
      >(async (_account, _cp, persist) => {
        await persist({ messages: parsed.messages, resumeAnchor: null });
        return {
          complete: false,
          reason: 'unsupported_dom',
          skipped: ['general_folder_unsupported'],
        };
      }),
    };
    try {
      await expect(
        accounts.syncSocialInbox(id, randomUUID()),
      ).rejects.toThrow();
      expect(
        (await accounts.listSocialAccounts(user)).find((row) => row.id === id)
          ?.canSyncInbox,
      ).toBe(true);
      expect(
        (await accounts.listSocialAccounts(randomUUID())).find(
          (row) => row.id === id,
        )?.canSyncInbox,
      ).toBe(false);
      for (const patch of [
        { status: 'disabled' },
        { status: 'paused' },
        { sessionStatus: 'unconfirmed' },
        { channel: 'linkedin' },
      ]) {
        await db.sonarPool.query(
          "update channel_accounts set channel=$2,status=$3,settings=settings||jsonb_build_object('sessionStatus',$4::text) where id=$1",
          [
            id,
            patch.channel ?? 'instagram',
            patch.status ?? 'active',
            patch.sessionStatus ?? 'valid',
          ],
        );
        await expect(accounts.syncSocialInbox(id, user)).rejects.toThrow();
      }
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='social.inbox.sync' and payload->>'accountId'=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
      await db.sonarPool.query(
        "update channel_accounts set channel='instagram',status='active',settings=settings||'{\"sessionStatus\":\"valid\"}'::jsonb where id=$1",
        [id],
      );
      const receipts = await Promise.all(
        Array.from({ length: 3 }, () => accounts.syncSocialInbox(id, user)),
      );
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
      expect(receipts.filter((receipt) => receipt.created)).toHaveLength(1);
      const taskId = receipts[0]!.id!;
      const task = (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          taskId,
        ])
      ).rows[0];
      expect(task.payload).toEqual({
        accountId: id,
        mode: 'manual',
        requestedBy: user,
      });
      expect(
        await worker.runSocialInboxSync(
          { accountId: id, mode: 'manual' } as { accountId: string },
          adapter,
          now,
        ),
      ).toMatchObject({
        status: 'skipped',
        reasonCode: 'social_inbox_disabled',
      });
      expect(adapter.sync).not.toHaveBeenCalled();
      expect(
        await worker.runSocialInboxSync(task.payload, adapter, now, taskId),
      ).toMatchObject({
        status: 'done',
        result: { created: 5, mode: 'manual', complete: false },
      });
      const state = (
        await db.sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [id],
        )
      ).rows[0].settings;
      expect(state.inboxSync).toMatchObject({
        watermark: '2026-11-13T10:00:00.000Z',
        nextPollAt: previousPoll,
        complete: false,
      });
      expect(state.socialAction.counts).toEqual({ sync: 1 });
      expect(
        await worker.runSocialInboxSync(task.payload, adapter, now, taskId),
      ).toMatchObject({ status: 'deferred', reasonCode: 'social_action_gate' });
      expect(adapter.sync).toHaveBeenCalledOnce();
      await db.sonarPool.query("update tasks set status='failed' where id=$1", [
        taskId,
      ]);
      expect(await tasks.retryTask(taskId, randomUUID())).toBe(false);
      // The task record may fail before pg-boss acknowledges its current job.
      expect(await tasks.retryTask(taskId, user)).toBe(false);
      let jobs = (
        await db.sonarPool.query(
          "select id from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1 and state in ('created','retry','active')",
          [taskId],
        )
      ).rows;
      await admin.cancel(
        'social.inbox.sync',
        jobs.map((row) => row.id),
      );
      expect(await tasks.retryTask(taskId, user)).toBe(true);
      jobs = (
        await db.sonarPool.query(
          "select id from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1 and state in ('created','retry','active')",
          [taskId],
        )
      ).rows;
      expect(jobs).toHaveLength(1);
      expect(
        (
          await db.sonarPool.query('select payload from tasks where id=$1', [
            taskId,
          ])
        ).rows[0].payload,
      ).toEqual(task.payload);
      await db.sonarPool.query(
        'update channel_accounts set owner_id=null where id=$1',
        [id],
      );
      expect(
        await worker.runSocialInboxSync(task.payload, adapter, now, taskId),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'social_inbox_manual_unauthorized',
      });
      await db.sonarPool.query(
        'update channel_accounts set owner_id=$2 where id=$1',
        [id, user],
      );
      // A killed worker must not strand this account when global polling is off.
      await admin.cancel(
        'social.inbox.sync',
        jobs.map((row) => row.id),
      );
      await db.sonarPool.query(
        "update tasks set status='running' where id=$1",
        [taskId],
      );
      const recovered = await accounts.syncSocialInbox(id, user);
      expect(recovered.created).toBe(true);
      expect(recovered.id).not.toBe(taskId);
      expect(
        (
          await db.sonarPool.query('select status from tasks where id=$1', [
            taskId,
          ])
        ).rows[0].status,
      ).toBe('failed');
      expect(await tasks.retryTask(taskId, user)).toBe(true);
      expect(
        (
          await db.sonarPool.query('select result from tasks where id=$1', [
            taskId,
          ])
        ).rows[0].result.retryTaskId,
      ).toBe(recovered.id);
      await db.sonarPool.query(
        "update channel_accounts set status='disabled' where id=$1",
        [id],
      );
      expect(
        await worker.runSocialInboxSync(
          task.payload,
          adapter,
          new Date(now.getTime() + 180000),
          taskId,
        ),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'social_account_inactive',
      });
      expect(await inbox.reconcileSocialInbox(now)).toBe(0);
      expect(
        (
          await db.sonarPool.query(
            "select value from settings where key='social.inbox.enabled'",
          )
        ).rows[0].value,
      ).toBe(false);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where account_id=$1)",
            [id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.sonarPool.query(
        "delete from tasks where (type='social.inbox.sync' and payload->>'accountId'=$1::text) or payload->>'messageId' in(select id::text from messages where account_id=$1::uuid)",
        [id],
      );
      await db.sonarPool.query('delete from messages where account_id=$1', [
        id,
      ]);
      await db.sonarPool.query(
        'delete from conversations where account_id=$1',
        [id],
      );
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        id,
      ]);
      await db.sonarPool.query(
        "update settings set value='true' where key in ('social.inbox.enabled','social.inbox.facebook.enabled','social.inbox.instagram.enabled')",
      );
    }
  },
);
it.skipIf(!enabled)(
  'keeps empty Instagram observations unverified and preserves partial watermark through later attributable imports',
  async () => {
    const id = randomUUID();
    const watermark = '2026-11-13T10:00:00.000Z';
    const cookies = encryptSocialCookies(
      JSON.stringify([
        {
          name: 'sessionid',
          value: 'stub',
          domain: '.instagram.com',
          session: true,
        },
        {
          name: 'ds_user_id',
          value: '900000000000004',
          domain: '.instagram.com',
          session: true,
        },
      ]),
      'instagram',
      process.env.AUTH_SECRET!,
    );
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'instagram','Observed inbox test','','active',20,$2)",
      [
        id,
        {
          sessionStatus: 'valid',
          inboxPollingEnabled: true,
          cookiesEncrypted: cookies,
          proxyIndex: 0,
          proxyFingerprint: socialProxyFingerprint({
            server: 'http://proxy.invalid:8000',
          }),
          inboxSync: { watermark },
        },
      ],
    );
    try {
      const { captureInstagramInbox } =
        await import('../../../apps/worker/src/instagram-inbox-browser.js');
      const full = JSON.parse(
        readFileSync(
          new URL(
            '../../../apps/worker/src/instagram-inbox.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const opaqueIds = JSON.parse(
        readFileSync(
          new URL(
            '../../../apps/worker/src/instagram-message-ids.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const messageEdges =
        full.data.get_slide_mailbox_for_iris_subscription.threads_by_folder
          .edges[0].node.as_ig_direct_thread.slide_messages.edges;
      messageEdges[0].node.id = opaqueIds.incoming;
      messageEdges[1].node.id = opaqueIds.outgoing;
      const empty = structuredClone(full);
      let observations = [{ name: 'PolarisDirectInboxQuery', body: empty }];
      const requests = JSON.parse(
        readFileSync(
          new URL(
            '../../../apps/worker/src/instagram-requests.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      empty.data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges =
        [];
      let url = '';
      let listener: ((response: unknown) => void) | undefined;
      const frame = { url: () => url };
      const page = {
        on: (_event: string, fn: typeof listener) => {
          listener = fn;
        },
        off: () => {
          listener = undefined;
        },
        url: () => url,
        mainFrame: () => frame,
        goto: async (target: string) => {
          url = target;
          for (const observation of target.endsWith('/requests/')
            ? [{ name: 'PolarisDirectMessageRequestQuery', body: requests }]
            : observations)
            listener?.({
              url: () => 'https://www.instagram.com/api/graphql',
              status: () => 200,
              request: () => ({
                method: () => 'POST',
                url: () => 'https://www.instagram.com/api/graphql',
                frame: () => frame,
                postData: () =>
                  new URLSearchParams({
                    fb_api_req_friendly_name: observation.name,
                  }).toString(),
              }),
              json: async () => observation.body,
            });
          return { status: () => 200 };
        },
        waitForTimeout: async (ms: number) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      };
      const emptyAdapter: import('../../../apps/worker/src/social-inbox.js').SocialInboxAdapter =
        {
          sync: async (_account, _checkpoint, persist) =>
            captureInstagramInbox(
              page as unknown as Parameters<typeof captureInstagramInbox>[0],
              25,
              persist,
              async () => {},
              '900000000000004',
            ),
        };
      expect(
        await worker.runSocialInboxSync({ accountId: id }, emptyAdapter, now),
      ).toMatchObject({
        status: 'done',
        result: {
          created: 0,
          complete: false,
          reason: 'unsupported_dom',
          skipped: expect.arrayContaining(['no_verified_mailbox']),
        },
      });
      const state = (
        await db.sonarPool.query(
          'select status,settings from channel_accounts where id=$1',
          [id],
        )
      ).rows[0];
      expect(state.status).toBe('active');
      expect(state.settings.sessionStatus).toBe('valid');
      expect(state.settings.sessionCheckReason).toBeUndefined();
      expect(state.settings.inboxSync).toMatchObject({
        watermark,
        complete: false,
      });
      expect(
        (
          await db.sonarPool.query(
            'select count(*)::int as n from messages where account_id=$1',
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
      const adapter: import('../../../apps/worker/src/social-inbox.js').SocialInboxAdapter =
        {
          async sync(_account, _checkpoint, persist) {
            observations = [
              {
                name: 'useIGDSystemFolderUnreadThreadCountQuery',
                body: JSON.parse(
                  readFileSync(
                    new URL(
                      '../../../apps/worker/src/instagram-unread-count.fixture.json',
                      import.meta.url,
                    ),
                    'utf8',
                  ),
                ),
              },
              { name: 'PolarisDirectInboxQuery', body: full },
              { name: 'PolarisDirectInboxQuery', body: full },
            ];
            return captureInstagramInbox(
              page as unknown as Parameters<typeof captureInstagramInbox>[0],
              500,
              persist,
              async () => {},
              '900000000000004',
            );
          },
        };
      expect(
        await worker.runSocialInboxSync(
          { accountId: id },
          adapter,
          new Date(state.settings.socialAction.nextAt),
        ),
      ).toMatchObject({
        status: 'done',
        result: {
          created: 5,
          complete: false,
          skipped: ['general_folder_unsupported', 'unsupported_query_ignored'],
        },
      });
      const { parseInstagramInbox } =
        await import('../../../apps/worker/src/instagram-inbox-parser.js');
      const repeated = parseInstagramInbox(full, now.toISOString())!.messages;
      expect(
        await inbox.persistSocialInboxBatch(id, 'instagram', {
          messages: repeated,
          resumeAnchor: null,
        }),
      ).toMatchObject({ created: 0, conflicts: [] });
      const rows = (
        await db.sonarPool.query('select * from messages where account_id=$1', [
          id,
        ])
      ).rows;
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.external_message_id)).toEqual(
        expect.arrayContaining([opaqueIds.incoming, opaqueIds.outgoing]),
      );
      const outgoing = rows.filter((row) => row.direction === 'out');
      expect(outgoing).toHaveLength(4);
      outgoing.forEach((row) => {
        expect(row.social_meta.senderPlatformId).toBe('900000000000003');
        expect(row.social_meta.senderProfile).toBeUndefined();
      });
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='ai.inbound' and payload->>'messageId'=any($1::text[])",
            [rows.map((row) => row.id)],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.sonarPool.query(
            'select settings from channel_accounts where id=$1',
            [id],
          )
        ).rows[0].settings.inboxSync,
      ).toMatchObject({ watermark, complete: false });
    } finally {
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in(select id::text from messages where account_id=$1)",
        [id],
      );
      await db.sonarPool.query('delete from messages where account_id=$1', [
        id,
      ]);
      await db.sonarPool.query(
        'delete from conversations where account_id=$1',
        [id],
      );
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        id,
      ]);
    }
  },
);
it.skipIf(!enabled)(
  'manually imports Facebook unknown-time replies into the existing account dialog while all polling gates are closed',
  async () => {
    const accounts = await import('./social-accounts.js');
    const profile = 'https://www.facebook.com/100000000000009/';
    const threadId = '900000000000009';
    const contact = (
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual') returning id",
        [secondCompany, profile],
      )
    ).rows[0];
    const dialog = (
      await db.sonarPool.query(
        "insert into conversations(channel,account_id,peer_value,contact_id,company_id) values('social',$1,$2,$3,$4) returning id",
        [account, profile, contact.id, secondCompany],
      )
    ).rows[0];
    const before = await checkpoint();
    await db.sonarPool.query(
      'update channel_accounts set owner_id=$2 where id=$1',
      [account, user],
    );
    await db.sonarPool.query(
      "update settings set value='false' where key in ('social.inbox.enabled','social.inbox.facebook.enabled','social.inbox.instagram.enabled')",
    );
    try {
      expect(await inbox.reconcileSocialInbox(now)).toBe(0);
      const receipt = await accounts.syncSocialInbox(account, user);
      const observed = {
        ...message('100000000000009@msgr.1', 'in', profile),
        threadId,
        occurredAt: null,
        providerTimestamp: '01:08',
        providerOrder: 0,
      };
      const batch = {
        messages: [
          observed,
          {
            ...observed,
            externalMessageId: '100000000000008@msgr.2',
            providerOrder: 1,
            direction: 'out' as const,
            senderProfile: 'https://www.facebook.com/100000000000008/',
          },
        ],
        resumeAnchor: {
          threadUrl:
            'https://www.facebook.com/messages/e2ee/t/' + threadId + '/',
        },
      };
      const adapter = {
        sync: vi.fn<
          import('../../../apps/worker/src/social-inbox.js').SocialInboxAdapter['sync']
        >(async (_a, _cp, persist) => {
          await persist(batch);
          await persist(batch);
          return {
            complete: false,
            reason: 'unsupported_dom',
            skipped: ['pagination_unverified'],
          };
        }),
      };
      expect(
        await worker.runSocialInboxSync(
          { accountId: account },
          adapter,
          now,
          receipt.id,
        ),
      ).toMatchObject({
        status: 'done',
        result: { mode: 'manual', created: 2, complete: false },
      });
      const rows = (
        await db.sonarPool.query(
          'select conversation_id,sent_at,social_meta from messages where account_id=$1 and external_message_id=any($2::text[])',
          [account, batch.messages.map((m) => m.externalMessageId)],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      rows.forEach((row) => {
        expect(row.conversation_id).toBe(dialog.id);
        expect(row.sent_at).toBeNull();
        expect(row.social_meta.occurredAt).toBeNull();
        expect(row.social_meta.observedAt).toBe(now.toISOString());
      });
      const chat = await inbound.getConversationChat(dialog.id);
      expect(chat.messages.every((m) => m.providerTimestampUnknown)).toBe(true);
      expect(chat.messages.map((m) => m.direction)).toEqual(['in', 'out']);
      expect(chat.conversation?.companyId).toBe(secondCompany);
      const cp = await checkpoint();
      expect(cp.watermark).toBe(before?.watermark ?? null);
      expect(cp.nextPollAt).toBe(before?.nextPollAt);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where conversation_id=$1)",
            [dialog.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='message.send' and payload->>'messageId' in(select id::text from messages where conversation_id=$1)",
            [dialog.id],
          )
        ).rows[0].n,
      ).toBe(0);
      await db.sonarPool.query("update tasks set status='done' where id=$1", [
        receipt.id,
      ]);
      await db.sonarPool.query(
        "update settings set value='true' where key='social.inbox.enabled'",
      );
      await resetGate();
      expect(
        await worker.runSocialInboxSync({ accountId: account }, adapter, now),
      ).toMatchObject({
        status: 'skipped',
        reasonCode: 'social_inbox_disabled',
      });
      expect(await inbox.reconcileSocialInbox(now)).toBe(0);
      expect(adapter.sync).toHaveBeenCalledOnce();
      const stranger = 'https://www.facebook.com/100000000000099/';
      await inbox.persistSocialInboxBatch(account, 'facebook', {
        messages: [
          {
            ...observed,
            externalMessageId: '100000000000099@msgr.3',
            threadId: '900000000000099',
            senderProfile: stranger,
            peerProfile: stranger,
          },
        ],
        resumeAnchor: null,
      });
      expect(
        (
          await db.sonarPool.query(
            'select company_id from conversations where account_id=$1 and provider_thread_id=$2',
            [account, '900000000000099'],
          )
        ).rows[0].company_id,
      ).toBeNull();
      await expect(
        accounts.setSocialInboxPolling(account, true, randomUUID()),
      ).rejects.toThrow();
      await accounts.setSocialInboxPolling(account, false, user);
    } finally {
      const threads = [threadId, '900000000000099'];
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in(select id::text from messages where conversation_id in(select id from conversations where account_id=$1 and provider_thread_id=any($2::text[])))",
        [account, threads],
      );
      await db.sonarPool.query(
        'delete from messages where conversation_id in(select id from conversations where account_id=$1 and provider_thread_id=any($2::text[]))',
        [account, threads],
      );
      await db.sonarPool.query(
        'delete from conversations where account_id=$1 and provider_thread_id=any($2::text[])',
        [account, threads],
      );
      await db.sonarPool.query('delete from contacts where id=$1', [
        contact.id,
      ]);
      await db.sonarPool.query(
        "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',$2::jsonb) where id=$1",
        [account, JSON.stringify(before ?? {})],
      );
      await db.sonarPool.query(
        'update channel_accounts set owner_id=null,settings=settings||\'{"inboxPollingEnabled":true}\'::jsonb where id=$1',
        [account],
      );
      await db.sonarPool.query(
        "update settings set value='true' where key in ('social.inbox.enabled','social.inbox.facebook.enabled','social.inbox.instagram.enabled')",
      );
    }
  },
);
it.skipIf(!enabled)(
  'imports both directions once, scopes threads to accounts, matches unambiguously and queues only inbound AI',
  async () => {
    const batch = {
      messages: [message('in-1'), message('out-1', 'out')],
      resumeAnchor: { page: 1 },
    };
    expect(
      await inbox.persistSocialInboxBatch(account, 'facebook', batch),
    ).toMatchObject({ created: 2 });
    expect(
      await inbox.persistSocialInboxBatch(account, 'facebook', batch),
    ).toMatchObject({ created: 0 });
    await inbox.persistSocialInboxBatch(other, 'facebook', batch);
    const rows = (
      await db.sonarPool.query(
        'select m.*,v.company_id from messages m join conversations v on v.id=m.conversation_id where m.account_id=$1 order by direction',
        [account],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].company_id).toBe(company);
    expect(rows[0].source).toBe('inbound');
    expect(rows[1].source).toBe('manual');
    expect(rows[1].sent_at).toEqual(new Date(batch.messages[1]!.occurredAt!));
    expect(rows[0].social_meta).toMatchObject({
      network: 'facebook',
      senderProfile: peer,
      observedAt: now.toISOString(),
    });
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from tasks where type='ai.inbound' and payload->>'messageId'=any($1::text[])",
          [rows.map((row) => row.id)],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int as n from conversations where account_id=any($1::uuid[]) and provider_thread_id=$2',
          [[account, other], batch.messages[0]!.threadId],
        )
      ).rows[0].n,
    ).toBe(2);
    const reply = await inbound.queueConversationReply(
      {
        conversationId: rows[0].conversation_id,
        body: 'Manual answer',
        socialDelivery: 'browser',
        requestId: randomUUID(),
      },
      user,
    );
    expect(
      (
        await db.sonarPool.query(
          'select account_id from messages where id=$1',
          [reply.id],
        )
      ).rows[0].account_id,
    ).toBe(account);
    await db.sonarPool.query(
      "update channel_accounts set status='paused' where id=$1",
      [account],
    );
    await expect(
      inbound.queueConversationReply(
        {
          conversationId: rows[0].conversation_id,
          body: 'Do not switch account',
          socialDelivery: 'browser',
          requestId: randomUUID(),
        },
        user,
      ),
    ).rejects.toThrow('активний акаунт');
    expect(
      (await inbound.getConversationChat(rows[0].conversation_id))
        .socialAvailable,
    ).toBe(false);
    await resetGate();
    await inbound.applyInboundClassification(rows[0].id, 'refusal');
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int as n from do_not_contact where company_id=$1',
          [company],
        )
      ).rows[0].n,
    ).toBe(2);
  },
);
it.skipIf(!enabled)(
  'keeps ambiguous peers without a company and never hides old same-body outgoing messages',
  async () => {
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual')",
      [secondCompany, peer],
    );
    const ambiguous = { ...message('ambiguous'), threadId: 'ambiguous-thread' };
    await inbox.persistSocialInboxBatch(account, 'facebook', {
      messages: [ambiguous],
      resumeAnchor: null,
    });
    const {
      rows: [conversation],
    } = await db.sonarPool.query(
      'select * from conversations where account_id=$1 and provider_thread_id=$2',
      [account, ambiguous.threadId],
    );
    expect(conversation.company_id).toBeNull();
    await db.sonarPool.query(
      "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key) values($1,$2,'social','out','manual',$3,'','Hello','sent',$4)",
      [conversation.id, account, peer, randomUUID()],
    );
    const saved = await inbox.persistSocialInboxBatch(account, 'facebook', {
      messages: [
        {
          ...ambiguous,
          externalMessageId: 'legacy-observed',
          direction: 'out',
          senderProfile: 'https://facebook.com/own_account/',
        },
      ],
      resumeAnchor: null,
    });
    expect(saved.created).toBe(1);
    expect(saved.conflicts).toHaveLength(1);
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from messages where conversation_id=$1 and direction='out'",
          [conversation.id],
        )
      ).rows[0].n,
    ).toBe(2);
  },
);
it.skipIf(!enabled)(
  'persists partial pages before failure, resumes anchors, and advances watermark only after full completion',
  async () => {
    await resetGate();
    const first = await worker.runSocialInboxSync(
      { accountId: account },
      {
        sync: async (a, cp, persist) => {
          expect(a.id).toBe(account);
          expect(a.session.proxy.server).toBe('http://proxy.invalid:8000');
          expect(cp.watermark).toBeNull();
          await persist({
            messages: [message('partial')],
            resumeAnchor: { thread: 'partial', page: 2 },
          });
          expect((await checkpoint()).resumeAnchor).toEqual({
            thread: 'partial',
            page: 2,
          });
          throw Error('interrupted');
        },
      },
      now,
    );
    expect(first.status).toBe('failed');
    expect((await checkpoint()).watermark).toBeNull();
    expect(
      (await checkpoint()).threadCursors[message('partial').threadId],
    ).toMatchObject({ lastMessageAt: message('partial').occurredAt });
    await resetGate();
    const partial = await worker.runSocialInboxSync(
      { accountId: account },
      {
        sync: async (_a, cp, persist) => {
          expect(cp.resumeAnchor).toEqual({ thread: 'partial', page: 2 });
          await persist({
            messages: [message('partial')],
            resumeAnchor: { page: 3 },
          });
          return { complete: false, reason: 'history_locked' };
        },
      },
      new Date(now.getTime() + 180000),
    );
    expect(partial).toMatchObject({
      status: 'done',
      result: { created: 0, complete: false, reason: 'history_locked' },
    });
    expect((await checkpoint()).watermark).toBeNull();
    await resetGate();
    const finished = await worker.runSocialInboxSync(
      { accountId: account },
      { sync: async () => ({ complete: true }) },
      new Date(now.getTime() + 360000),
    );
    expect(finished).toMatchObject({
      status: 'done',
      result: { complete: true },
    });
    expect(await checkpoint()).toMatchObject({
      watermark: now.toISOString(),
      resumeAnchor: null,
      cycleStartedAt: null,
    });
  },
);
it.skipIf(!enabled)(
  'distinguishes history lock/unsupported DOM from invalid cookies and pauses checkpoints/rate limits',
  async () => {
    expect(
      await worker.runSocialInboxSync({ accountId: account }),
    ).toMatchObject({
      status: 'skipped',
      reasonCode: 'social_inbox_missing_adapter',
    });
    for (const code of ['history_locked', 'unsupported_dom'] as const) {
      await resetGate();
      expect(
        await worker.runSocialInboxSync(
          { accountId: account },
          {
            sync: async () => {
              throw new worker.SocialInboxAdapterError(
                code,
                'Перевірте історію вручну.',
              );
            },
          },
          now,
        ),
      ).toMatchObject({ status: 'paused', reasonCode: `social_inbox_${code}` });
      expect(
        (
          await db.sonarPool.query(
            'select status,settings from channel_accounts where id=$1',
            [account],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'active',
        settings: { sessionStatus: 'valid' },
      });
    }
    for (const reason of [
      'checkpoint',
      'rate_limit',
      'cookies_invalid',
    ] as const) {
      await resetGate();
      expect(
        (
          await db.sonarPool.query(
            "select settings->>'inboxPollingEnabled' as polling,(select value from settings where key='social.inbox.enabled') as global,(select value from settings where key='social.inbox.facebook.enabled') as facebook from channel_accounts where id=$1",
            [account],
          )
        ).rows[0],
      ).toEqual({ polling: 'true', global: true, facebook: true });
      await db.sonarPool.query(
        'update channel_accounts set settings=settings||\'{"sessionStatus":"valid"}\'::jsonb where id=$1',
        [account],
      );
      expect(
        await worker.runSocialInboxSync(
          { accountId: account },
          {
            sync: async () => {
              throw new SocialSessionCheckError(reason);
            },
          },
          now,
        ),
      ).toMatchObject({
        status: 'paused',
        reasonCode: `social_inbox_${reason}`,
      });
      expect(
        (
          await db.sonarPool.query(
            'select status,settings from channel_accounts where id=$1',
            [account],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'paused',
        settings: {
          sessionStatus: reason === 'rate_limit' ? 'unconfirmed' : 'invalid',
          inboxPollingEnabled: false,
        },
      });
    }
    const adapter = { sync: vi.fn() };
    expect(
      await worker.runSocialInboxSync({ accountId: account }, adapter, now),
    ).toMatchObject({
      status: 'paused',
      reasonCode: 'social_account_inactive',
    });
    expect(adapter.sync).not.toHaveBeenCalled();
    await db.sonarPool.query(
      'update channel_accounts set status=\'active\',settings=settings||\'{"sessionStatus":"valid"}\'::jsonb where id=$1',
      [account],
    );
  },
);
it.skipIf(!enabled)(
  'shares account lock with send and separate action counters, and reconciles one scheduled job per account',
  async () => {
    await resetGate();
    const c = await db.sonarPool.connect();
    try {
      await c.query(
        "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
        [account],
      );
      const adapter = { sync: vi.fn() };
      expect(
        await worker.runSocialInboxSync({ accountId: account }, adapter, now),
      ).toMatchObject({
        status: 'deferred',
        reasonCode: 'social_account_busy',
      });
      expect(adapter.sync).not.toHaveBeenCalled();
    } finally {
      await c.query(
        "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
        [account],
      );
      c.release();
    }
    await worker.runSocialInboxSync(
      { accountId: account },
      { sync: async () => ({ complete: true }) },
      now,
    );
    const { reserveSocialAction } = await import('@sonar/db/social-action');
    const gate = await db.sonarPool.connect();
    try {
      await gate.query('begin');
      expect(await reserveSocialAction(gate, account, 'send', now)).toEqual(
        new Date(now.getTime() + 120000),
      );
      await gate.query('commit');
    } finally {
      gate.release();
    }
    expect(
      (
        await db.sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [account],
        )
      ).rows[0].settings.socialAction.counts,
    ).toEqual({ sync: 1 });
    await Promise.all([
      inbox.reconcileSocialInbox(now),
      inbox.reconcileSocialInbox(now),
    ]);
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running')",
          [account],
        )
      ).rows[0].n,
    ).toBe(1);
    const job = (
      await db.sonarPool.query(
        "select start_after from pgboss.job where name='social.inbox.sync' and data->>'taskId'=(select id::text from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status='queued')",
        [account],
      )
    ).rows[0];
    const nextPollAt = Date.parse((await checkpoint()).nextPollAt);
    expect(nextPollAt - now.getTime()).toBeGreaterThanOrEqual(126000);
    expect(nextPollAt - now.getTime()).toBeLessThanOrEqual(234000);
    expect(job.start_after).toEqual(new Date(nextPollAt));
    const old = (
      await db.sonarPool.query(
        "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status='queued'",
        [account],
      )
    ).rows[0].id;
    await db.sonarPool.query(
      "update pgboss.job set state='failed' where name='social.inbox.sync' and data->>'taskId'=$1",
      [old],
    );
    await inbox.reconcileSocialInbox(now);
    expect(
      (
        await db.sonarPool.query(
          'select status,reason_code from tasks where id=$1',
          [old],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', reason_code: 'social_inbox_interrupted' });
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status='queued'",
          [account],
        )
      ).rows[0].n,
    ).toBe(1);

    const c2 = await db.sonarPool.connect();
    try {
      await c2.query('begin');
      expect(
        await reserveSocialAction(
          c2,
          account,
          'send',
          new Date(now.getTime() + 120000),
        ),
      ).toBeNull();
      await c2.query('commit');
    } finally {
      c2.release();
    }
    const state = (
      await db.sonarPool.query(
        'select settings,attempt_count,daily_limit from channel_accounts where id=$1',
        [account],
      )
    ).rows[0];
    expect(state.settings.socialAction.counts).toEqual({ sync: 1, send: 1 });
    expect(state.daily_limit).toBe(20);
    await db.sonarPool.query(
      "update channel_accounts set settings=jsonb_set(settings,'{socialAction}',$2::jsonb) where id=$1",
      [
        account,
        JSON.stringify({
          day: now.toISOString().slice(0, 10),
          counts: { sync: 480 },
          nextAt: now.toISOString(),
        }),
      ],
    );
    const capped = { sync: vi.fn() };
    expect(
      await worker.runSocialInboxSync({ accountId: account }, capped, now),
    ).toMatchObject({
      status: 'deferred',
      runAt: new Date('2026-11-15T00:00:00Z'),
    });
    expect(capped.sync).not.toHaveBeenCalled();
  },
);
it.skipIf(!enabled)(
  'scopes the same opaque Instagram message ID to each receiving account and queues inbound AI once per account',
  async () => {
    const receivingAccounts = [randomUUID(), randomUUID()];
    const { incoming: providerId } = JSON.parse(
      readFileSync(
        new URL(
          '../../../apps/worker/src/instagram-message-ids.fixture.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const batch = {
      messages: [
        {
          ...message(
            providerId,
            'in',
            'https://www.instagram.com/example_peer/',
          ),
          threadId: '900000000000005',
        },
      ],
      resumeAnchor: null,
    };
    try {
      for (const id of receivingAccounts) {
        await db.sonarPool.query(
          "insert into channel_accounts(id,channel,name,address,daily_limit) values($1,'instagram','Opaque ID fixture','',20)",
          [id],
        );
        expect(
          await inbox.persistSocialInboxBatch(id, 'instagram', batch),
        ).toMatchObject({ created: 1, conflicts: [] });
        expect(
          await inbox.persistSocialInboxBatch(id, 'instagram', batch),
        ).toMatchObject({ created: 0, conflicts: [] });
        const rows = (
          await db.sonarPool.query(
            'select id,external_message_id from messages where account_id=$1',
            [id],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].external_message_id).toBe(providerId);
        expect(
          (
            await db.sonarPool.query(
              "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId'=$1",
              [rows[0].id],
            )
          ).rows[0].n,
        ).toBe(1);
      }
    } finally {
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in(select id::text from messages where account_id=any($1::uuid[]))",
        [receivingAccounts],
      );
      await db.sonarPool.query(
        'delete from messages where account_id=any($1::uuid[])',
        [receivingAccounts],
      );
      await db.sonarPool.query(
        'delete from conversations where account_id=any($1::uuid[])',
        [receivingAccounts],
      );
      await db.sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [receivingAccounts],
      );
    }
  },
);
it.skipIf(!enabled).each(['instagram', 'linkedin'] as const)(
  'imports %s via the same ID contract and matches a unique network-scoped handle',
  async (network) => {
    const id = randomUUID();
    const profile =
      network === 'instagram'
        ? 'https://www.instagram.com/unique_handle/'
        : 'https://www.linkedin.com/in/unique_handle/';
    const contact = (
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source,meta) values($1,'social','@unique_handle','@unique_handle','manual',$2) returning id",
        [secondCompany, { network }],
      )
    ).rows[0];
    try {
      await db.sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,daily_limit) values($1,$2,'Network fixture','',20)",
        [id, network],
      );
      const item = {
        ...message('network-specific', 'in', profile),
        threadId: 'provider-thread',
      };
      expect(
        await inbox.persistSocialInboxBatch(id, network, {
          messages: [
            item,
            {
              ...item,
              externalMessageId: 'own-phone',
              direction: 'out',
              senderProfile: profile,
            },
          ],
          resumeAnchor: null,
        }),
      ).toMatchObject({ created: 2 });
      expect(
        await inbox.persistSocialInboxBatch(id, network, {
          messages: [item],
          resumeAnchor: null,
        }),
      ).toMatchObject({ created: 0 });
      expect(
        (
          await db.sonarPool.query(
            'select company_id from conversations where account_id=$1',
            [id],
          )
        ).rows[0].company_id,
      ).toBe(secondCompany);
    } finally {
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in (select id::text from messages where account_id=$1)",
        [id],
      );
      await db.sonarPool.query('delete from messages where account_id=$1', [
        id,
      ]);
      await db.sonarPool.query(
        'delete from conversations where account_id=$1',
        [id],
      );
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        id,
      ]);
      await db.sonarPool.query('delete from contacts where id=$1', [
        contact.id,
      ]);
    }
  },
);
it.skipIf(!enabled)(
  'preserves observed outgoing ID on existing honest FB dispatch row and sync deduplicates it',
  async () => {
    const { sendEmailMessage } = await import('@sonar/db/email');
    await resetGate();
    const freshPeer = 'https://www.facebook.com/fresh_peer/';
    await inbox.persistSocialInboxBatch(account, 'facebook', {
      messages: [message('fresh-in', 'in', freshPeer)],
      resumeAnchor: null,
    });
    const conversation = (
      await db.sonarPool.query(
        'select id from conversations where account_id=$1 and peer_value=$2',
        [account, freshPeer],
      )
    ).rows[0];
    const reply = await inbound.queueConversationReply(
      {
        conversationId: conversation.id,
        body: 'Observed send',
        socialDelivery: 'browser',
        requestId: randomUUID(),
      },
      user,
    );
    const result = await sendEmailMessage(
      reply.id,
      randomUUID(),
      async (req, a) => {
        await a!.beforeSend!();
        return {
          outcome: 'facebook_dispatched_unconfirmed',
          dialogUrl: req.to,
          externalMessageId: 'real-dom-id',
          observation: {
            inputExactMatch: true,
            dispatchPerformed: true,
            outgoingBefore: 1,
            outgoingAfter: 2,
            newOutgoing: true,
            observationMs: 10000,
            lateError: 'none',
          },
        };
      },
      now,
      () => 0,
      'social',
    );
    expect(result).toMatchObject({
      status: 'done',
      result: { delivery: 'unconfirmed' },
    });
    const saved = await inbox.persistSocialInboxBatch(account, 'facebook', {
      messages: [
        { ...message('real-dom-id', 'out', freshPeer), body: 'Observed send' },
      ],
      resumeAnchor: null,
    });
    expect(saved).toEqual({ created: 0, conflicts: [] });
    expect(
      (
        await db.sonarPool.query(
          'select external_message_id,reason_uk from messages where id=$1',
          [reply.id],
        )
      ).rows[0],
    ).toEqual({
      external_message_id: 'real-dom-id',
      reason_uk: facebookDispatchReason,
    });
  },
);
it.skipIf(!enabled)(
  'defers session checks behind the shared action gap and counts checks separately',
  async () => {
    const { reserveSocialAction } = await import('@sonar/db/social-action');
    const { withSocialSessionCheck } = await import('./social-accounts.js');
    await resetGate();
    const c = await db.sonarPool.connect();
    try {
      await c.query('begin');
      await reserveSocialAction(c, account, 'send', now);
      await c.query('commit');
    } finally {
      c.release();
    }
    const check = vi.fn(async () => ({ valid: true }));
    expect(await withSocialSessionCheck(account, check, now)).toMatchObject({
      status: 'deferred',
      reasonCode: 'social_action_gate',
      runAt: new Date(now.getTime() + 120000),
    });
    expect(check).not.toHaveBeenCalled();
    expect(
      await withSocialSessionCheck(
        account,
        check,
        new Date(now.getTime() + 120000),
      ),
    ).toMatchObject({ status: 'done' });
    expect(check).toHaveBeenCalledOnce();
    const state = (
      await db.sonarPool.query(
        'select settings from channel_accounts where id=$1',
        [account],
      )
    ).rows[0].settings;
    expect(state.socialAction.counts).toEqual({ send: 1, check: 1 });
    expect(state.socialAction.nextAt).toBe(
      new Date(now.getTime() + 240000).toISOString(),
    );
    const adapter = { sync: vi.fn() };
    expect(
      await worker.runSocialInboxSync(
        { accountId: account },
        adapter,
        new Date(now.getTime() + 120000),
      ),
    ).toMatchObject({ status: 'deferred', reasonCode: 'social_action_gate' });
    expect(adapter.sync).not.toHaveBeenCalled();
  },
);
it.skipIf(!enabled)(
  'keeps the account lock without an open transaction and preserves sanitized paused diagnostics',
  async () => {
    const { withSocialSessionCheck } = await import('./social-accounts.js');
    await resetGate();
    let idleTransactions: unknown[] = [];
    let lockedDuringCallback = true;
    let committedCount = 0;
    const diagnostic = {
      version: 1,
      stage: 'auth',
      urlKind: 'feed',
      navigationHttpStatus: 200,
      errorKind: 'timeout',
      visible: {
        legacyAuth: 0,
        semanticAuth: 0,
        captcha: 0,
        checkpoint: 0,
        login: 0,
      },
    } as const;
    const result = await withSocialSessionCheck(
      account,
      async () => {
        idleTransactions = (
          await db.sonarPool.query(
            "select pid from pg_stat_activity where datname=current_database() and state='idle in transaction'",
          )
        ).rows;
        const c = await db.sonarPool.connect();
        try {
          lockedDuringCallback = (
            await c.query(
              "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
              [account],
            )
          ).rows[0].locked;
          if (lockedDuringCallback)
            await c.query(
              "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
              [account],
            );
          committedCount =
            (
              await c.query(
                'select settings from channel_accounts where id=$1',
                [account],
              )
            ).rows[0].settings.socialAction?.counts?.check ?? 0;
        } finally {
          c.release();
        }
        return {
          valid: false,
          reason: 'unknown_auth',
          diagnostic: {
            ...diagnostic,
            rawUrl: 'https://private.invalid/?token=secret',
          },
        };
      },
      now,
    );
    expect(result).toMatchObject({
      status: 'paused',
      result: { valid: false, diagnostic },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|token|secret|rawUrl/);
    expect(idleTransactions).toEqual([]);
    expect(lockedDuringCallback).toBe(false);
    expect(committedCount).toBe(1);
    await db.sonarPool.query(
      'update channel_accounts set status=\'active\',settings=settings||\'{"sessionStatus":"valid"}\'::jsonb where id=$1',
      [account],
    );
  },
);
it.skipIf(!enabled)(
  'reuses the reconciled account job when an older failed sync is retried concurrently',
  async () => {
    await resetGate();
    await inbox.reconcileSocialInbox(now);
    const active = (
      await db.sonarPool.query(
        "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running')",
        [account],
      )
    ).rows[0].id;
    const old = randomUUID();
    await db.sonarPool.query(
      "insert into tasks(id,type,idempotency_key,status,payload) values($1::uuid,'social.inbox.sync',$1::uuid::text,'failed',$2)",
      [old, { accountId: account }],
    );
    const attempts = await Promise.allSettled([
      tasks.retryTask(old, user),
      tasks.retryTask(old, user),
      inbox.reconcileSocialInbox(now),
    ]);
    expect(attempts.slice(0, 2)).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
    ]);
    expect(
      (
        await db.sonarPool.query(
          'select status,result from tasks where id=$1',
          [old],
        )
      ).rows[0],
    ).toMatchObject({ status: 'failed', result: { retryTaskId: active } });
    expect(
      (
        await db.sonarPool.query(
          "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running')",
          [account],
        )
      ).rows,
    ).toEqual([{ id: active }]);
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1",
          [active],
        )
      ).rows[0].n,
    ).toBe(1);
    // Also race a manual retry against creating a replacement after the active job ends.
    await db.sonarPool.query("update tasks set status='done' where id=$1", [
      active,
    ]);
    const replacement = await Promise.allSettled([
      tasks.retryTask(old, user),
      inbox.reconcileSocialInbox(now),
      tasks.retryTask(old, user),
    ]);
    expect(replacement.every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    const pending = (
      await db.sonarPool.query(
        "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running')",
        [account],
      )
    ).rows;
    expect(pending).toHaveLength(1);
    const retried = (
      await db.sonarPool.query('select result from tasks where id=$1', [old])
    ).rows[0];
    expect(retried.result?.retryTaskId).toBe(
      pending[0].id === old ? undefined : pending[0].id,
    );
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int as n from pgboss.job where name='social.inbox.sync' and data->>'taskId'=$1",
          [pending[0].id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
it.skipIf(!enabled)(
  'skips an already queued inbox job when polling is disabled without reserving an action',
  async () => {
    await resetGate();
    await inbox.reconcileSocialInbox(now);
    const queued = (
      await db.sonarPool.query(
        "select payload from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status='queued'",
        [account],
      )
    ).rows[0];
    const before = (
      await db.sonarPool.query(
        'select settings from channel_accounts where id=$1',
        [account],
      )
    ).rows[0].settings;
    await db.sonarPool.query(
      "update settings set value='false' where key='social.inbox.enabled'",
    );
    try {
      const adapter = { sync: vi.fn(async () => ({ complete: true })) };
      expect(
        await worker.runSocialInboxSync(queued.payload, adapter, now),
      ).toMatchObject({
        status: 'skipped',
        reasonCode: 'social_inbox_disabled',
      });
      expect(adapter.sync).not.toHaveBeenCalled();
      expect(
        (
          await db.sonarPool.query(
            'select settings from channel_accounts where id=$1',
            [account],
          )
        ).rows[0].settings,
      ).toEqual(before);
    } finally {
      await db.sonarPool.query(
        "update settings set value='true' where key='social.inbox.enabled'",
      );
    }
  },
);
afterAll(async () => {
  if (!enabled) return;
  for (const setting of originalSettings)
    await db.sonarPool.query('update settings set value=$2 where key=$1', [
      setting.key,
      JSON.stringify(setting.value),
    ]);
  await db.sonarPool.query(
    "delete from tasks where (type='social.inbox.sync' and payload->>'accountId'=any($1::text[])) or payload->>'messageId' in(select id::text from messages where account_id=any($1::uuid[]))",
    [[account, other]],
  );
  await db.sonarPool.query(
    'delete from messages where account_id=any($1::uuid[])',
    [[account, other]],
  );
  await db.sonarPool.query(
    'delete from conversations where account_id=any($1::uuid[])',
    [[account, other]],
  );
  await db.sonarPool.query(
    'delete from do_not_contact where company_id=any($1::uuid[])',
    [[company, secondCompany]],
  );
  await db.sonarPool.query(
    'delete from contacts where company_id=any($1::uuid[])',
    [[company, secondCompany]],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    [company, secondCompany],
  ]);
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [[account, other]],
  );
  await db.sonarPool.query('delete from users where id=$1', [user]);
  await admin?.stop();
  await tasks.closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  if (originalSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalSecret;
  if (originalProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
  else process.env.SOCIAL_PROXY_URLS = originalProxies;
});
