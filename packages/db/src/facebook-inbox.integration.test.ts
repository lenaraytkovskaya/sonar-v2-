import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SocialInboxMessage } from '@sonar/core/social-inbox';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let inbox: typeof import('./social-inbox.js');
let inbound: typeof import('./inbound.js');
let tasks: typeof import('./tasks.js');
const accounts: string[] = [];
const peer = 'https://www.facebook.com/100000000000001/';
const observedAt = '2026-11-15T03:00:00.000Z';
const companies: string[] = [];
async function account() {
  const id = randomUUID();
  accounts.push(id);
  await db.sonarPool.query(
    "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','P2 regression','','active',20,'{\"sessionStatus\":\"valid\"}')",
    [id],
  );
  return id;
}
const m = (id: string, order: number, at = observedAt): SocialInboxMessage => ({
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
const save = (id: string, messages: SocialInboxMessage[]) =>
  inbox.persistSocialInboxBatch(id, 'facebook', {
    messages,
    resumeAnchor: null,
  });
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  inbox = await import('./social-inbox.js');
  inbound = await import('./inbound.js');
  tasks = await import('./tasks.js');
  await tasks.boss.start();
  await tasks.boss.createQueue('ai.inbound');
  await tasks.boss.createQueue('form.reply.match');
});
it.skipIf(!enabled)(
  'orders an earlier unknown-date message before the overlap from the previous poll without changing dates',
  async () => {
    const id = await account();
    await save(id, [m('B', 1)]);
    await save(id, [
      m('A', 0, '2026-11-15T03:03:00.000Z'),
      m('B', 1, '2026-11-15T03:03:00.000Z'),
    ]);
    const v = (
      await db.sonarPool.query(
        'select id from conversations where account_id=$1',
        [id],
      )
    ).rows[0];
    const chat = await inbound.getConversationChat(v.id);
    expect(chat.messages.map((x) => x.body)).toEqual(['A', 'B']);
    expect(chat.messages.every((x) => x.providerTimestampUnknown)).toBe(true);
    expect(
      (
        await db.sonarPool.query(
          'select external_message_id,created_at,social_meta from messages where account_id=$1 order by external_message_id',
          [id],
        )
      ).rows.map((row) => [
        row.external_message_id,
        row.created_at.toISOString(),
        row.social_meta.occurredAt,
      ]),
    ).toEqual([
      ['A', '2026-11-15T03:03:00.000Z', null],
      ['B', observedAt, null],
    ]);
  },
);
it.skipIf(!enabled).each([false, true])(
  'rejects a conflicting established peer even when the legacy contact matches (known ID: %s)',
  async (knownId) => {
    const company = randomUUID();
    companies.push(company);
    const id = await account();
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$1::uuid::text,'P2 regression','PL')",
      [company],
    );
    const ct = (
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual') returning id",
        [company, peer],
      )
    ).rows[0];
    const oldPeer = 'https://www.facebook.com/profile.php?id=100000000000099';
    const v = (
      await db.sonarPool.query(
        "insert into conversations(channel,account_id,peer_value,contact_id,company_id) values('social',$1,$2,$3,$4) returning id",
        [id, oldPeer, ct.id, company],
      )
    ).rows[0];
    await db.sonarPool.query(
      "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,external_message_id,social_meta) values($1,$2,'social','out','manual',$3,'','Old peer history','sent',$4,$5,$6)",
      [
        v.id,
        id,
        oldPeer,
        randomUUID(),
        knownId ? 'new-peer-reply' : null,
        { network: 'facebook' },
      ],
    );
    await expect(
      save(id, [
        {
          ...m('new-peer-reply', 0),
          direction: knownId ? 'out' : 'in',
          senderProfile: knownId
            ? 'https://www.facebook.com/100000000000002/'
            : peer,
        },
      ]),
    ).rejects.toThrow('співрозмовник');
    expect(
      (
        await db.sonarPool.query(
          'select peer_value,provider_thread_id from conversations where id=$1',
          [v.id],
        )
      ).rows[0],
    ).toEqual({ peer_value: oldPeer, provider_thread_id: null });
    expect(
      (await inbound.getConversationChat(v.id)).messages.map((x) => x.body),
    ).toEqual(['Old peer history']);
  },
);
it.skipIf(!enabled)(
  'uses later overlap to resolve disconnected windows, preserves replay and rejects contradictory provider order',
  async () => {
    const id = await account();
    await save(id, [m('B', 0), m('D', 1)]);
    await save(id, [m('B', 0), m('C', 1)]);
    await save(id, [m('C', 0), m('D', 1)]);
    const v = (
      await db.sonarPool.query(
        'select id from conversations where account_id=$1',
        [id],
      )
    ).rows[0];
    expect(
      (await inbound.getConversationChat(v.id)).messages.map((row) => row.body),
    ).toEqual(['B', 'C', 'D']);
    expect(await save(id, [m('C', 0), m('D', 1)])).toMatchObject({
      created: 0,
    });
    await expect(save(id, [m('D', 0), m('B', 1)])).rejects.toThrow(
      'Суперечливий порядок',
    );
    expect(
      (await inbound.getConversationChat(v.id)).messages.map((row) => row.body),
    ).toEqual(['B', 'C', 'D']);
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where account_id=$1)",
          [id],
        )
      ).rows[0].n,
    ).toBe(3);
  },
);
it
  .skipIf(!enabled)
  .each([
    'failed',
    'queued',
    'ambiguous-local',
    'ambiguous-provider',
    'outside-window',
    'unknown-date',
    'other-thread',
    'other-body',
    'other-account',
    'unmarked',
  ])('reconciles a marked outgoing observation safely: %s', async (mode) => {
  const id = await account();
  const v = (
    await db.sonarPool.query(
      "insert into conversations(channel,account_id,provider_thread_id,peer_value) values('social',$1,'900000000000001',$2) returning id",
      [id, peer],
    )
  ).rows[0];
  const localAccount = mode === 'other-account' ? await account() : id;
  const localConversation = ['other-thread', 'other-account'].includes(mode)
    ? (
        await db.sonarPool.query(
          "insert into conversations(channel,account_id,provider_thread_id,peer_value) values('social',$1,'900000000000002',$2) returning id",
          [localAccount, peer],
        )
      ).rows[0].id
    : v.id;
  const attempted =
    mode === 'outside-window' ? '2026-11-15T01:00:00Z' : '2026-11-15T02:42:00Z';
  const localIds: string[] = [];
  for (let i = 0; i < (mode === 'ambiguous-local' ? 2 : 1); i++) {
    const row = (
      await db.sonarPool.query(
        `insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,first_attempt_at)
         values($1,$2,'social','out','manual',$3,'',$7,$4,$5,$6) returning id`,
        [
          localConversation,
          localAccount,
          peer,
          mode === 'queued' ? 'queued' : 'failed',
          randomUUID(),
          mode === 'unmarked' ? null : attempted,
          mode === 'other-body' ? 'Different body' : 'Same body',
        ],
      )
    ).rows[0];
    localIds.push(row.id);
  }
  const observed: SocialInboxMessage = {
    ...m('observed-out', 0),
    direction: 'out',
    senderProfile: 'https://www.facebook.com/100000000000002/',
    body: 'Same body',
    occurredAt: mode === 'unknown-date' ? null : '2026-11-15T02:42:45Z',
  };
  const batch = [
    observed,
    ...(mode === 'ambiguous-provider'
      ? [{ ...observed, externalMessageId: 'observed-out-2', providerOrder: 1 }]
      : []),
  ];
  await save(id, batch);
  await save(id, batch);
  const { rows } = await db.sonarPool.query(
    'select id,status,external_message_id,first_attempt_at,needs_human from messages where account_id=$1 or id=any($2::uuid[])',
    [id, localIds],
  );
  if (mode === 'failed' || mode === 'queued') {
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: localIds[0],
      status: 'sent',
      external_message_id: 'observed-out',
    });
    expect(rows[0].first_attempt_at.toISOString()).toBe(
      '2026-11-15T02:42:00.000Z',
    );
  } else {
    expect(rows).toHaveLength(localIds.length + batch.length);
    if (mode === 'unknown-date')
      expect(rows.every((row) => row.needs_human)).toBe(true);
    expect(
      rows
        .filter((row) => localIds.includes(row.id))
        .every((row) => row.external_message_id === null),
    ).toBe(true);
  }
});
afterAll(async () => {
  if (!enabled) return;
  await db.sonarPool.query(
    "delete from tasks where payload->>'messageId' in(select id::text from messages where account_id=any($1::uuid[]))",
    [accounts],
  );
  await db.sonarPool.query(
    'delete from messages where account_id=any($1::uuid[])',
    [accounts],
  );
  await db.sonarPool.query(
    'delete from conversations where account_id=any($1::uuid[])',
    [accounts],
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
