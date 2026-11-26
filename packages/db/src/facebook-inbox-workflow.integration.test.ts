import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  encryptSocialCookies,
  socialProxyFingerprint,
} from '@sonar/core/social-session';
import type { SocialInboxMessage } from '@sonar/core/social-inbox';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let inbox: typeof import('./social-inbox.js');
let inbound: typeof import('./inbound.js');
let tasks: typeof import('./tasks.js');
let originalSettings: { key: string; value: unknown }[] = [];
const originalSecret = process.env.AUTH_SECRET,
  originalProxies = process.env.SOCIAL_PROXY_URLS;
const companies: string[] = [];
const accounts: string[] = [],
  conversations: string[] = [],
  users: string[] = [];
const peer = 'https://www.facebook.com/100000000000001/';
const at = '2026-11-15T03:00:00.000Z';
const m = (id: string, order = 0, observedAt = at): SocialInboxMessage => ({
  externalMessageId: id,
  threadId: '900000000000001',
  direction: 'in',
  senderProfile: peer,
  peerProfile: peer,
  body: id,
  occurredAt: null,
  observedAt,
  providerTimestamp: '01:08',
  providerOrder: order,
});
const save = (id: string, messages: SocialInboxMessage[]) =>
  inbox.persistSocialInboxBatch(id, 'facebook', {
    messages,
    resumeAnchor: { phase: 'before' },
  });
async function account() {
  const id = randomUUID();
  accounts.push(id);
  await db.sonarPool.query(
    "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','R3','','active',20,$2)",
    [
      id,
      {
        sessionStatus: 'valid',
        cookiesEncrypted: encryptSocialCookies(
          JSON.stringify([
            {
              name: 'c_user',
              value: '100000000000002',
              domain: '.facebook.com',
              path: '/',
              session: true,
            },
          ]),
          'facebook',
          process.env.AUTH_SECRET!,
        ),
        proxyIndex: 0,
        proxyFingerprint: socialProxyFingerprint({
          server: 'http://proxy.invalid:8000',
        }),
      },
    ],
  );
  return id;
}
async function user() {
  const id = randomUUID();
  users.push(id);
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'R3','stub')",
    [id, id + '@invalid.test'],
  );
  return id;
}
async function conv(id: string) {
  const v = (
    await db.sonarPool.query(
      'select id from conversations where account_id=$1',
      [id],
    )
  ).rows[0].id;
  conversations.push(v);
  return v as string;
}
beforeAll(async () => {
  if (!enabled) return;
  process.env.AUTH_SECRET =
    'isolated-r3-test-secret-with-at-least-32-characters';
  process.env.SOCIAL_PROXY_URLS = 'http://proxy.invalid:8000';
  db = await import('./index.js');
  inbox = await import('./social-inbox.js');
  inbound = await import('./inbound.js');
  tasks = await import('./tasks.js');
  originalSettings = (
    await db.sonarPool.query(
      "select key,value from settings where key='send.hours'",
    )
  ).rows;
  await db.sonarPool.query(
    "update settings set value=$1 where key='send.hours'",
    [JSON.stringify({ start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })],
  );
  await tasks.boss.start();
  for (const name of [
    'form.reply.match',
    'ai.inbound',
    'ai.reply',
    'message.send',
  ])
    await tasks.boss.createQueue(name);
});
it.skipIf(!enabled)(
  'a normal AI reply draft must not prevent the next inbox import',
  async () => {
    const id = await account();
    await save(id, [m('in-1')]);
    const v = await conv(id);
    await inbound.saveReplyDraft(v, { body: 'draft reply' }, randomUUID());
    await expect(save(id, [m('in-1'), m('in-2', 1)])).resolves.toMatchObject({
      created: 1,
    });
    expect(
      (await inbound.getConversationChat(v)).messages.filter(
        (row) => row.direction === 'in',
      ),
    ).toHaveLength(2);
  },
);
it.skipIf(!enabled)(
  'an owner-recorded manual reply must not prevent the next inbox import',
  async () => {
    const id = await account();
    await save(id, [m('manual-in-1')]);
    const v = await conv(id);
    await inbound.queueConversationReply(
      {
        conversationId: v,
        body: 'manual reply',
        requestId: randomUUID(),
        socialDelivery: 'manual',
      },
      await user(),
    );
    await expect(
      save(id, [m('manual-in-1'), m('manual-in-2', 1)]),
    ).resolves.toMatchObject({ created: 1 });
  },
);
it.skipIf(!enabled)(
  'marking through the last visible inbound clears the earlier provider-ordered history',
  async () => {
    const id = await account();
    await save(id, [m('B', 1)]);
    await save(id, [
      m('A', 0, '2026-11-15T03:03:00.000Z'),
      m('B', 1, '2026-11-15T03:03:00.000Z'),
    ]);
    const v = await conv(id),
      before = await inbound.getConversationChat(v);
    expect(before.messages.map((row) => row.body)).toEqual(['A', 'B']);
    await inbound.markConversationRead(v, before.messages.at(-1)!.id);
    expect(
      (await inbound.getConversationChat(v)).conversation?.unreadCount,
    ).toBe(0);
  },
);
it
  .skipIf(!enabled)
  .each([
    'receipt',
    'missing_receipt',
    'mixed_account',
    'wrong_peer',
    'sent_null',
    'marked_before_sync',
  ] as const)(
  'repairs only a proven local legacy draft: %s',
  async (variant) => {
    const id = await account();
    await save(id, [m('initial')]);
    const v = await conv(id);
    const draft = await inbound.saveReplyDraft(
      v,
      { body: 'legacy draft' },
      randomUUID(),
    );
    await db.sonarPool.query(
      'update messages set account_id=null,social_meta=null where id=$1',
      [draft.id],
    );
    if (variant === 'missing_receipt')
      await db.sonarPool.query(
        "delete from activity_log where action='message.reply.drafted' and details->>'messageId'=$1",
        [draft.id],
      );
    if (variant === 'mixed_account')
      await db.sonarPool.query(
        "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key) values($1,$2,'social','out','manual',$3,'','Other account','sent',$4)",
        [v, await account(), peer, randomUUID()],
      );
    if (variant === 'wrong_peer')
      await db.sonarPool.query('update messages set to_value=$2 where id=$1', [
        draft.id,
        'https://www.facebook.com/100000000000099/',
      ]);
    if (variant === 'sent_null')
      await db.sonarPool.query(
        "update messages set status='sent' where id=$1",
        [draft.id],
      );
    if (variant === 'marked_before_sync')
      await (
        await import('./outreach.js')
      ).markOutreachManualSent(draft.id, await user());
    const allowed = variant === 'receipt' || variant === 'marked_before_sync';
    if (allowed)
      await expect(
        save(id, [m('initial'), m('next', 1)]),
      ).resolves.toMatchObject({ created: 1 });
    else await expect(save(id, [m('initial'), m('next', 1)])).rejects.toThrow();
    expect(
      (
        await db.sonarPool.query(
          'select account_id from messages where id=$1',
          [draft.id],
        )
      ).rows[0].account_id,
    ).toBe(allowed ? id : null);
  },
);
it.skipIf(!enabled)(
  'uses a displayed ID snapshot to leave newly imported earlier/later messages unread and respects its boundary',
  async () => {
    const id = await account();
    await save(id, [m('B', 1)]);
    const v = await conv(id);
    const before = await inbound.getConversationChat(v),
      boundary = before.messages.map((row) => row.id);
    await save(id, [
      m('A', 0, '2026-11-15T03:03:00.000Z'),
      m('B', 1),
      m('C', 2),
    ]);
    await inbound.markConversationRead(v, boundary[0], boundary);
    let current = await inbound.getConversationChat(v);
    expect(
      current.messages.map((row) => [row.body, Boolean(row.readAt)]),
    ).toEqual([
      ['A', false],
      ['B', true],
      ['C', false],
    ]);
    const ids = current.messages.map((row) => row.id);
    await inbound.markConversationRead(v, ids[0], ids);
    current = await inbound.getConversationChat(v);
    expect(
      current.messages.map((row) => [row.body, Boolean(row.readAt)]),
    ).toEqual([
      ['A', true],
      ['B', true],
      ['C', false],
    ]);
    await inbound.markConversationRead(v, randomUUID(), ids);
    expect(
      (await inbound.getConversationChat(v)).conversation?.unreadCount,
    ).toBe(1);
    await inbound.markConversationRead(v, ids[2], ids);
    await inbound.markConversationRead(v, ids[2], ids);
    expect(
      (await inbound.getConversationChat(v)).conversation?.unreadCount,
    ).toBe(0);
  },
);
it.skipIf(!enabled)(
  'completes import → AI draft → manual mark → send stub → new import → read and repeat with one send/AI per ID',
  async () => {
    const id = await account();
    await save(id, [m('first')]);
    const v = await conv(id),
      actor = await user();
    const { draftReply } = await import('../../../apps/worker/src/inbound.js');
    const taskId = randomUUID();
    const assist = vi.fn(async () => ({
      status: 'done' as const,
      result: { text: JSON.stringify({ body: 'AI reply' }) },
    }));
    const outcome = await draftReply({ conversationId: v }, taskId, assist);
    expect(outcome.status).toBe('done');
    expect(assist).toHaveBeenCalledOnce();
    const draftId = (outcome.result as { messageId: string }).messageId;
    expect(
      await inbound.saveReplyDraft(v, { body: 'AI reply' }, taskId),
    ).toMatchObject({ id: draftId });
    await (
      await import('./outreach.js')
    ).markOutreachManualSent(draftId, actor);
    const manualId = randomUUID();
    const manual = await inbound.queueConversationReply(
      {
        conversationId: v,
        body: 'Manual reply',
        requestId: manualId,
        socialDelivery: 'manual',
      },
      actor,
    );
    expect(
      await inbound.queueConversationReply(
        {
          conversationId: v,
          body: 'Manual reply',
          requestId: manualId,
          socialDelivery: 'manual',
        },
        actor,
      ),
    ).toMatchObject({ id: manual.id });
    await expect(save(id, [m('first'), m('second', 1)])).resolves.toMatchObject(
      { created: 1 },
    );
    const requestId = randomUUID();
    const sent = await inbound.queueConversationReply(
      {
        conversationId: v,
        body: 'Browser reply',
        requestId,
        socialDelivery: 'browser',
      },
      actor,
    );
    const { sendEmailMessage } = await import('./email.js');
    const sender = vi.fn<import('./email.js').ChannelSender>(
      async (req, account) => {
        expect(account?.id).toBe(id);
        await account!.beforeSend!();
        return {
          outcome: 'facebook_dispatched_unconfirmed',
          dialogUrl: req.to,
          externalMessageId: 'provider-send',
          observation: {
            inputExactMatch: true,
            dispatchPerformed: true,
            outgoingBefore: 0,
            outgoingAfter: 1,
            newOutgoing: true,
            observationMs: 10000,
            lateError: 'none',
          },
        };
      },
    );
    expect(
      await sendEmailMessage(
        sent.id,
        randomUUID(),
        sender,
        new Date(at),
        () => 0,
        'social',
      ),
    ).toMatchObject({ status: 'done', result: { delivery: 'unconfirmed' } });
    const observations = [
      m('first'),
      m('second', 1),
      {
        ...m('provider-send', 2),
        direction: 'out' as const,
        senderProfile: 'https://www.facebook.com/100000000000002/',
        body: 'Browser reply',
      },
      m('third', 3),
    ];
    expect(await save(id, observations)).toMatchObject({
      created: 1,
      conflicts: [],
    });
    expect(await save(id, observations)).toMatchObject({
      created: 0,
      conflicts: [],
    });
    expect(
      await sendEmailMessage(
        sent.id,
        randomUUID(),
        sender,
        new Date(at),
        () => 0,
        'social',
      ),
    ).toMatchObject({ status: 'done', result: { messageId: sent.id } });
    expect(sender).toHaveBeenCalledOnce();
    const chat = await inbound.getConversationChat(v);
    const incoming = chat.messages
      .filter((row) => row.direction === 'in')
      .map((row) => row.id);
    await inbound.markConversationRead(v, incoming.at(-1), incoming);
    await inbound.markConversationRead(v, incoming.at(-1), incoming);
    expect(
      (await inbound.getConversationChat(v)).conversation?.unreadCount,
    ).toBe(0);
    const rows = (
      await db.sonarPool.query(
        'select account_id,reason_uk,external_message_id from messages where conversation_id=$1',
        [v],
      )
    ).rows;
    expect(rows.every((row) => row.account_id === id)).toBe(true);
    expect(
      rows.find((row) => row.external_message_id === 'provider-send')
        ?.reason_uk,
    ).toBeNull();
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where conversation_id=$1)",
          [v],
        )
      ).rows[0].n,
    ).toBe(3);
  },
);
it.skipIf(!enabled)(
  'serializes local draft editing and new replies with the same receiving identity and lock order',
  async () => {
    const id = await account();
    await save(id, [m('initial')]);
    const v = await conv(id),
      actor = await user(),
      co = randomUUID();
    companies.push(co);
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$1::uuid::text,'R3','PL')",
      [co],
    );
    await db.sonarPool.query(
      'update conversations set company_id=$2 where id=$1',
      [v, co],
    );
    const draft = await inbound.saveReplyDraft(
      v,
      { body: 'Initial draft' },
      randomUUID(),
    );
    const outreach = await import('./outreach.js');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2
          ? outreach.editOutreachDraft(draft.id, { body: 'Edited ' + i }, actor)
          : inbound.saveReplyDraft(v, { body: 'Draft ' + i }, randomUUID()),
      ),
    );
    expect(await save(id, [m('initial'), m('next', 1)])).toMatchObject({
      created: 1,
    });
    expect(
      (
        await db.sonarPool.query(
          'select distinct account_id from messages where conversation_id=$1',
          [v],
        )
      ).rows,
    ).toEqual([{ account_id: id }]);
  },
);
it.skipIf(!enabled)(
  'retains PR101 row-locked draft compare-and-set and guarded manual marks after Facebook integration',
  async () => {
    const id = await account();
    await save(id, [m('initial')]);
    const v = await conv(id),
      actor = await user();
    const draft = await inbound.saveReplyDraft(
      v,
      { body: 'Original' },
      randomUUID(),
    );
    const outreach = await import('./outreach.js'),
      base = { subject: '', body: 'Original' };
    const edits = await Promise.allSettled(
      ['Left', 'Right'].map((body) =>
        outreach.editOutreachDraft(draft.id, { body }, actor, base),
      ),
    );
    expect(
      edits.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(edits.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
    const current = (
      await db.sonarPool.query(
        'select subject,body,status,account_id from messages where id=$1',
        [draft.id],
      )
    ).rows[0];
    expect(current.account_id).toBe(id);
    expect(current.status).toBe('draft');
    await expect(
      outreach.markOutreachManualSent(draft.id, actor, base),
    ).rejects.toThrow('Чернетку змінено');
    // A retried save with the accepted body is idempotent even after its response was lost.
    expect(
      await outreach.editOutreachDraft(
        draft.id,
        { body: current.body },
        actor,
        base,
      ),
    ).toMatchObject({ id: draft.id });
    await outreach.markOutreachManualSent(draft.id, actor, {
      subject: current.subject,
      body: current.body,
    });
    expect(await save(id, [m('initial'), m('next', 1)])).toMatchObject({
      created: 1,
    });
  },
);
afterAll(async () => {
  if (!enabled) return;
  await db.sonarPool.query(
    "delete from tasks where payload->>'messageId' in(select id::text from messages where conversation_id=any($1::uuid[]))",
    [conversations],
  );
  await db.sonarPool.query(
    'delete from messages where conversation_id=any($1::uuid[])',
    [conversations],
  );
  await db.sonarPool.query(
    'delete from conversations where id=any($1::uuid[])',
    [conversations],
  );
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [accounts],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companies,
  ]);
  await db.sonarPool.query('delete from users where id=any($1::uuid[])', [
    users,
  ]);
  for (const row of originalSettings)
    await db.sonarPool.query('update settings set value=$2 where key=$1', [
      row.key,
      JSON.stringify(row.value),
    ]);
  if (originalSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalSecret;
  if (originalProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
  else process.env.SOCIAL_PROXY_URLS = originalProxies;
  await tasks.closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
