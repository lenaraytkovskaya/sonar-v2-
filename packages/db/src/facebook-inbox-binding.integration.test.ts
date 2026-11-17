import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SocialInboxMessage } from '@sonar/core/social-inbox';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let inbox: typeof import('./social-inbox.js');
let inbound: typeof import('./inbound.js');
let outreach: typeof import('./outreach.js');
let tasks: typeof import('./tasks.js');
const accounts: string[] = [],
  companies: string[] = [],
  conversations: string[] = [];
const peer = 'https://www.facebook.com/100000000000001/';
const oldPeer = 'https://www.facebook.com/profile.php?id=100000000000099';
const own = 'https://www.facebook.com/100000000000002/';
const at = '2026-11-15T03:00:00.000Z';
const m = (id: string, order = 0): SocialInboxMessage => ({
  externalMessageId: id,
  threadId: '900000000000001',
  direction: 'in',
  senderProfile: peer,
  peerProfile: peer,
  body: id,
  occurredAt: null,
  observedAt: at,
  providerTimestamp: '01:08',
  providerOrder: order,
});
const save = (
  id: string,
  messages: SocialInboxMessage[],
  resumeAnchor: Record<string, unknown> = { phase: 'after' },
) => inbox.persistSocialInboxBatch(id, 'facebook', { messages, resumeAnchor });
async function account() {
  const id = randomUUID();
  accounts.push(id);
  await db.sonarPool.query(
    "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','R2','','active',20,$2)",
    [
      id,
      {
        sessionStatus: 'valid',
        inboxSync: { resumeAnchor: { phase: 'before' } },
      },
    ],
  );
  return id;
}
async function company() {
  const id = randomUUID();
  companies.push(id);
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$1::uuid::text,'R2','PL')",
    [id],
  );
  return id;
}
async function legacy(
  v: string,
  accountId: string | null,
  to: string,
  externalId: string | null = null,
  meta: Record<string, unknown> = { network: 'facebook' },
) {
  await db.sonarPool.query(
    "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,external_message_id,social_meta) values($1,$2,'social','out','reply',$3,'','legacy','sent',$4,$5,$6)",
    [v, accountId, to, randomUUID(), externalId, meta],
  );
}
async function chat(id: string) {
  return (
    await db.sonarPool.query(
      'select id from conversations where account_id=$1 and provider_thread_id=$2',
      [id, m('x').threadId],
    )
  ).rows[0].id as string;
}
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  inbox = await import('./social-inbox.js');
  inbound = await import('./inbound.js');
  outreach = await import('./outreach.js');
  tasks = await import('./tasks.js');
  await tasks.boss.start();
  await tasks.boss.createQueue('ai.inbound');
  await tasks.boss.createQueue('form.reply.match');
});
const paths = ['known', 'new', 'bound'] as const;
const histories = [
  'consistent',
  'mixed_account',
  'unknown_account',
  'historic_peer',
  'mixed_peer',
  'unknown_peer',
  'metadata_peer',
  'metadata_peer_type',
  'metadata_network',
] as const;
it
  .skipIf(!enabled)
  .each(
    paths.flatMap((path) => histories.map((history) => ({ path, history }))),
  )(
  'guards $path ID reuse against $history history atomically',
  async ({ path, history }) => {
    const id = await account(),
      co = await company();
    const contact = (
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual') returning id",
        [co, peer],
      )
    ).rows[0].id;
    const item =
      path === 'known'
        ? {
            ...m('known-dispatch'),
            direction: 'out' as const,
            senderProfile: own,
          }
        : m('new-B');
    const v = (
      await db.sonarPool.query(
        "insert into conversations(channel,company_id,contact_id,account_id,provider_thread_id,peer_value) values('social',$1,$2,$3,$4,$5) returning id",
        [
          co,
          contact,
          path === 'bound' ? id : null,
          path === 'bound' ? item.threadId : null,
          path === 'bound' ? peer : null,
        ],
      )
    ).rows[0].id;
    conversations.push(v);
    const historic =
      history === 'historic_peer'
        ? oldPeer
        : history === 'unknown_peer'
          ? ''
          : peer;
    await legacy(
      v,
      id,
      historic,
      path === 'known' ? item.externalMessageId : null,
      history === 'metadata_peer_type'
        ? { network: 'facebook', peerProfile: 123 }
        : history === 'metadata_peer'
          ? { network: 'facebook', peerProfile: oldPeer }
          : history === 'metadata_network'
            ? { network: 'instagram' }
            : { network: 'facebook' },
    );
    if (history === 'mixed_account') await legacy(v, await account(), peer);
    if (history === 'unknown_account') await legacy(v, null, peer);
    if (history === 'mixed_peer') await legacy(v, id, oldPeer);
    const before = (
      await db.sonarPool.query(
        'select account_id,peer_value,provider_thread_id from conversations where id=$1',
        [v],
      )
    ).rows[0];
    if (history === 'consistent') {
      expect(await save(id, [item])).toMatchObject({
        created: path === 'known' ? 0 : 1,
        conflicts: [],
      });
      expect(await save(id, [item])).toMatchObject({
        created: 0,
        conflicts: [],
      });
      expect(
        (
          await db.sonarPool.query(
            'select conversation_id from messages where account_id=$1 and external_message_id=$2',
            [id, item.externalMessageId],
          )
        ).rows[0].conversation_id,
      ).toBe(v);
    } else {
      const fresh = 'https://www.facebook.com/100000000000088/';
      await expect(
        save(id, [
          {
            ...m('atomic-new'),
            threadId: 'other-thread',
            senderProfile: fresh,
            peerProfile: fresh,
          },
          item,
        ]),
      ).rejects.toThrow();
      expect(
        (
          await db.sonarPool.query(
            'select account_id,peer_value,provider_thread_id from conversations where id=$1',
            [v],
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from messages where account_id=$1 and body='atomic-new'",
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.sonarPool.query(
            'select settings from channel_accounts where id=$1',
            [id],
          )
        ).rows[0].settings.inboxSync.resumeAnchor,
      ).toEqual({ phase: 'before' });
    }
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where account_id=$1)",
          [id],
        )
      ).rows[0].n,
    ).toBe(history === 'consistent' && path !== 'known' ? 1 : 0);
  },
);
it.skipIf(!enabled)(
  'uses the same overlapping order in Inbox, company history, previews and limited history',
  async () => {
    const id = await account(),
      co = await company();
    const cp = 'https://www.facebook.com/100000000000077/';
    const cm = (id: string, order: number) => ({
      ...m(id, order),
      peerProfile: cp,
      senderProfile: cp,
    });
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual')",
      [co, cp],
    );
    await save(id, [cm('B', 1)]);
    await save(id, [
      { ...cm('A', 0), observedAt: '2026-11-15T03:03:00.000Z' },
      cm('B', 1),
    ]);
    const v = await chat(id);
    const expected = (await inbound.getConversationChat(v)).messages.map(
      (row) => row.body,
    );
    expect(expected).toEqual(['A', 'B']);
    expect(
      (await outreach.getCompanyChat(co)).messages.map((row) => row.body),
    ).toEqual(expected);
    expect(
      (await (await import('./email.js')).getCompanyMessaging(co)).messages.map(
        (row) => row.body,
      ),
    ).toEqual([...expected].reverse());
    expect(
      (await inbound.getConversationChat(v, 1)).messages.map((row) => row.body),
    ).toEqual(['B']);
    expect(
      (await outreach.getInbox({ conversationId: v })).conversations[0]
        ?.lastMessage,
    ).toBe('B');
  },
);
it.skipIf(!enabled)(
  'keeps concurrent overlap edges and rolls back inserted messages, AI and checkpoint on a cycle',
  async () => {
    const id = await account();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        save(id, i % 2 ? [m('B', 0), m('C', 1)] : [m('A', 0), m('B', 1)], {
          phase: 'before',
        }),
      ),
    );
    const v = await chat(id);
    expect(
      (await inbound.getConversationChat(v)).messages.map((row) => row.body),
    ).toEqual(['A', 'B', 'C']);
    await expect(save(id, [m('C', 0), m('X', 1), m('A', 2)])).rejects.toThrow(
      'Суперечливий',
    );
    expect(
      (await inbound.getConversationChat(v)).messages.map((row) => row.body),
    ).toEqual(['A', 'B', 'C']);
    expect(
      (
        await db.sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [id],
        )
      ).rows[0].settings.inboxSync.resumeAnchor,
    ).toEqual({ phase: 'before' });
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where account_id=$1)",
          [id],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='message.send' and payload->>'messageId' in(select id::text from messages where account_id=$1)",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
afterAll(async () => {
  if (!enabled) return;
  await db.sonarPool.query(
    "delete from tasks where payload->>'messageId' in(select id::text from messages where account_id=any($1::uuid[]) or conversation_id=any($2::uuid[]))",
    [accounts, conversations],
  );
  await db.sonarPool.query(
    'delete from messages where account_id=any($1::uuid[]) or conversation_id=any($2::uuid[])',
    [accounts, conversations],
  );
  await db.sonarPool.query(
    'delete from conversations where account_id=any($1::uuid[]) or id=any($2::uuid[])',
    [accounts, conversations],
  );
  await db.sonarPool.query(
    'delete from contacts where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companies,
  ]);
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [accounts],
  );
  await tasks.closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
