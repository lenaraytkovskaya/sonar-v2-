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
