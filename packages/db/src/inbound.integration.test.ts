import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let inbound: typeof import('./inbound.js');
let email: typeof import('./email.js');
let tasks: typeof import('./tasks.js');
let admin: import('pg-boss').PgBoss;
const companyId = randomUUID(),
  accountId = randomUUID(),
  otherAccountId = randomUUID(),
  campaignId = randomUUID(),
  conversationId = randomUUID(),
  userId = randomUUID(),
  batchId = randomUUID(),
  contactId = randomUUID(),
  telegramAccountId = randomUUID();
const sender = `${companyId}@example.invalid`;
const unknown = `${randomUUID()}@example.invalid`;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  inbound = await import('./inbound.js');
  email = await import('./email.js');
  tasks = await import('./tasks.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const queue of ['ai.inbound', 'ai.reply', 'message.send'])
    await admin.createQueue(queue);
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'Inbound test','stub')",
    [userId, `${userId}@example.invalid`],
  );
  await db.sonarPool.query(
    "insert into channel_accounts(id,name,address,daily_limit,channel) values($1,'Inbound Telegram','+447700900123',100,'telegram')",
    [telegramAccountId],
  );
  await db.sonarPool.query(
    "insert into channel_accounts(id,name,address,daily_limit) values($1,'Inbound test','from@example.invalid',100),($2,'Other inbound test','other@example.invalid',100)",
    [accountId, otherAccountId],
  );
  await db.sonarPool.query(
    "insert into companies(id,name,country_code,status) values($1,'Inbound test','PL','contacted')",
    [companyId],
  );
  await db.sonarPool.query(
    "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status) values($1,'Inbound test','PL','pl','{}','{}','',1,'{\"email\":true}','{}','active')",
    [campaignId],
  );
  await db.sonarPool.query(
    "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
    [batchId, campaignId, randomUUID()],
  );
  await db.sonarPool.query(
    'insert into campaign_companies(company_id,campaign_id,batch_id) values($1,$2,$3)',
    [companyId, campaignId, batchId],
  );
  await db.sonarPool.query(
    "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,'email',$3,$3,'manual')",
    [contactId, companyId, sender],
  );
  await db.sonarPool.query(
    "insert into contacts(company_id,kind,value,normalized,source) values($1,'phone','+447700900123','+447700900123','manual'),($1,'telegram','@inbound_known','@inbound_known','manual')",
    [companyId],
  );
  await db.sonarPool.query(
    "insert into conversations(id,company_id,campaign_id,channel,contact_id) values($1,$2,$3,'email',$4)",
    [conversationId, companyId, campaignId, contactId],
  );
  await db.sonarPool.query(
    "insert into messages(conversation_id,account_id,to_value,subject,body,status,idempotency_key,provider_id,rfc_message_id) values($1,$2,$3,'Intro','Hello','sent',$4,$5,$6)",
    [
      conversationId,
      accountId,
      sender,
      randomUUID(),
      `original-${companyId}`,
      `<rfc-${companyId}@example.invalid>`,
    ],
  );
});
it.skipIf(!enabled)(
  'deduplicates concurrent provider deliveries atomically and follows email thread headers',
  async () => {
    const input = {
      channel: 'email' as const,
      accountId,
      providerId: `reply-${companyId}`,
      sender: `Thread Person <different-${sender}>`,
      body: 'Interested',
      inReplyTo: `<rfc-${companyId}@example.invalid>`,
    };
    const results = await Promise.all([
      inbound.recordInbound(input),
      inbound.recordInbound(input),
    ]);
    expect(results[0].messageId).toBe(results[1].messageId);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].conversationId).toBe(conversationId);
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int n from tasks where idempotency_key=$1',
          [`ai.inbound:${results[0].messageId}`],
        )
      ).rows[0].n,
    ).toBe(1);
    await inbound.applyInboundClassification(results[0].messageId, 'interest');
    expect(
      (
        await db.sonarPool.query('select status from companies where id=$1', [
          companyId,
        ])
      ).rows[0].status,
    ).toBe('interested');
    const sameKnown = await inbound.recordInbound({
      channel: 'email',
      accountId: otherAccountId,
      providerId: `known-${companyId}`,
      sender,
      body: 'Received on a different account',
    });
    expect(sameKnown.conversationId).toBe(conversationId);
  },
);
it.skipIf(!enabled)(
  'retains unknown senders, scopes provider IDs by account and reads only displayed messages',
  async () => {
    const first = await inbound.recordInbound({
      channel: 'email',
      accountId,
      providerId: 'same-provider-id',
      sender: unknown,
      body: 'How much?',
      externalMessageId: `<unknown-${companyId}@example.invalid>`,
      receivedAt: '2026-01-01T10:00:00Z',
    });
    expect(first.companyId).toBeNull();
    const second = await inbound.recordInbound({
      channel: 'email',
      accountId,
      providerId: `second-${companyId}`,
      sender: unknown,
      body: 'A follow up',
      receivedAt: '2026-01-01T10:01:00Z',
    });
    expect(second.conversationId).toBe(first.conversationId);
    const other = await inbound.recordInbound({
      channel: 'email',
      accountId: otherAccountId,
      providerId: 'same-provider-id',
      sender: unknown,
      body: 'Other account',
    });
    expect(other.messageId).not.toBe(first.messageId);
    expect(other.conversationId).not.toBe(first.conversationId);
    await inbound.applyInboundClassification(first.messageId, 'price');
    await inbound.applyInboundClassification(second.messageId, 'question');
    expect(
      (await inbound.getConversationChat(first.conversationId)).messages.find(
        (m) => m.id === second.messageId,
      )?.needsHuman,
    ).toBe(true);
    await inbound.markConversationRead(first.conversationId, first.messageId);
    const chat = await inbound.getConversationChat(first.conversationId);
    expect(chat.conversation?.needsHuman).toBe(true);
    expect(chat.conversation?.unreadCount).toBe(1);
    expect(
      chat.messages.find((m) => m.id === first.messageId)?.readAt,
    ).not.toBeNull();
    expect(
      chat.messages.find((m) => m.id === second.messageId)?.readAt,
    ).toBeNull();
    const draft = await inbound.saveReplyDraft(
      first.conversationId,
      { body: 'A colleague will contact you.' },
      randomUUID(),
    );
    expect(draft.status).toBe('draft');
    const history = await inbound.getConversationHistory(first.conversationId);
    expect(history.messages.some((m) => m.id === draft.id)).toBe(false);
    const original = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [['send.hours', 'send.min_gap_seconds', 'send.max_gap_seconds']],
      )
    ).rows;
    try {
      for (const [key, value] of [
        ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
        ['send.min_gap_seconds', 0],
        ['send.max_gap_seconds', 0],
      ])
        await db.sonarPool.query('update settings set value=$2 where key=$1', [
          key,
          JSON.stringify(value),
        ]);
      const outreach = await import('./outreach.js');
      const send = vi.fn(async () => 'reply-provider');
      for (const target of [first.conversationId, conversationId]) {
        const generated = await inbound.saveReplyDraft(
          target,
          { body: 'A human-approved response.' },
          randomUUID(),
        );
        expect(generated.status).toBe('draft');
        expect(
          (
            await db.sonarPool.query(
              "select count(*)::int n from tasks where type='message.send' and payload->>'messageId'=$1",
              [generated.id],
            )
          ).rows[0].n,
        ).toBe(0);
        const queued = await outreach.sendOutreachDraft(generated.id, userId);
        expect(queued.status).toBe('queued');
        expect(
          await email.sendEmailMessage(
            queued.id,
            randomUUID(),
            send,
            new Date('2026-11-13T10:00:00Z'),
            () => 0,
          ),
        ).toMatchObject({ status: 'done' });
        expect(
          (
            await db.sonarPool.query(
              'select status from messages where id=$1',
              [queued.id],
            )
          ).rows[0].status,
        ).toBe('sent');
        const sent = (
          await db.sonarPool.query(
            'select rfc_message_id,request_snapshot from messages where id=$1',
            [queued.id],
          )
        ).rows[0];
        expect(sent.request_snapshot.headers['Message-ID']).toBe(
          sent.rfc_message_id,
        );
        if (target === first.conversationId)
          expect(sent.request_snapshot.headers['In-Reply-To']).toBe(
            `<unknown-${companyId}@example.invalid>`,
          );
      }
      expect(send).toHaveBeenCalledTimes(2);
      const queuedBeforeRefusal = await inbound.queueConversationReply(
        {
          conversationId: first.conversationId,
          body: 'Previously queued reply',
          requestId: randomUUID(),
        },
        userId,
      );
      const refusal = await inbound.recordInbound({
        channel: 'email',
        accountId,
        providerId: `unknown-stop-${companyId}`,
        sender: unknown,
        body: 'Stop',
      });
      await inbound.applyInboundClassification(refusal.messageId, 'refusal');
      expect(await email.isContactBlocked(db.sonarPool, null, unknown)).toBe(
        true,
      );
      expect(
        await email.sendEmailMessage(
          queuedBeforeRefusal.id,
          randomUUID(),
          send,
        ),
      ).toMatchObject({ status: 'skipped', reasonCode: 'do_not_contact' });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      for (const row of original)
        await db.sonarPool.query('update settings set value=$2 where key=$1', [
          row.key,
          JSON.stringify(row.value),
        ]);
    }
  },
);
it.skipIf(!enabled)(
  'matches Telegram usernames and phones while preserving private unidentified senders',
  async () => {
    for (const [providerId, sender, senderPhone] of [
      [`tg-phone-${companyId}`, '@inbound_test', '+447700900123'],
      [`tg-user-${companyId}`, '@inbound_known', undefined],
    ]) {
      const result = await inbound.recordInbound({
        channel: 'telegram',
        accountId: telegramAccountId,
        providerId: providerId!,
        sender: sender!,
        senderPhone,
        body: 'Hello',
      });
      expect(result.companyId).toBe(companyId);
    }
    const unknownPeer = await inbound.recordInbound({
      channel: 'telegram',
      accountId: telegramAccountId,
      providerId: `tg-private-${companyId}`,
      sender: 'telegram:user:123456789',
      body: 'Private sender',
    });
    expect(unknownPeer.companyId).toBeNull();
  },
);
it.skipIf(!enabled)(
  'does not advance on autoreplies and blocks all channels transactionally after refusal',
  async () => {
    await db.sonarPool.query(
      "update companies set status='contacted' where id=$1",
      [companyId],
    );
    const auto = await inbound.recordInbound({
      channel: 'email',
      accountId,
      providerId: `auto-${companyId}`,
      sender,
      body: 'Away',
    });
    await inbound.applyInboundClassification(auto.messageId, 'autoreply');
    expect(
      (
        await db.sonarPool.query('select status from companies where id=$1', [
          companyId,
        ])
      ).rows[0].status,
    ).toBe('contacted');
    const queuedBeforeRefusal = await inbound.queueConversationReply(
      {
        conversationId,
        body: 'Queued before refusal',
        requestId: randomUUID(),
      },
      userId,
    );
    const refusal = await inbound.recordInbound({
      channel: 'email',
      accountId,
      providerId: `no-${companyId}`,
      sender,
      body: 'Stop contacting us',
      references: [`original-${companyId}`],
    });
    await inbound.applyInboundClassification(refusal.messageId, 'refusal');
    expect(
      (
        await db.sonarPool.query('select status from companies where id=$1', [
          companyId,
        ])
      ).rows[0].status,
    ).toBe('refused');
    const send = vi.fn(async () => 'must-not-send');
    expect(
      await email.sendEmailMessage(queuedBeforeRefusal.id, randomUUID(), send),
    ).toMatchObject({ status: 'skipped', reasonCode: 'do_not_contact' });
    expect(send).not.toHaveBeenCalled();
    expect(
      await email.isContactBlocked(
        db.sonarPool,
        companyId,
        'another@example.invalid',
      ),
    ).toBe(true);
    await expect(
      inbound.queueConversationReply(
        { conversationId, body: 'Another message', requestId: randomUUID() },
        randomUUID(),
      ),
    ).rejects.toThrow('Не контактувати');
  },
);
afterAll(async () => {
  if (!enabled) return;
  const { rows: conversations } = await db.sonarPool.query(
    'select distinct conversation_id id from messages where account_id=any($1::uuid[])',
    [[accountId, otherAccountId, telegramAccountId]],
  );
  const ids = conversations.map((r) => r.id);
  await db.sonarPool.query(
    "delete from tasks where type in ('ai.inbound','ai.reply','message.send') and (payload->>'messageId' in(select id::text from messages where conversation_id=any($1::uuid[])) or payload->>'conversationId'=any($2::text[]))",
    [ids, ids],
  );
  await db.sonarPool.query(
    'delete from activity_log where user_id=$1 or entity_id=$2 or entity_id=any($3::text[])',
    [userId, companyId, ids],
  );
  await db.sonarPool.query(
    'delete from messages where conversation_id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'delete from conversations where id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'delete from do_not_contact where company_id=$1 or value_normalized=$2',
    [companyId, unknown],
  );
  await db.sonarPool.query(
    'delete from campaign_companies where company_id=$1',
    [companyId],
  );
  await db.sonarPool.query('delete from batches where id=$1', [batchId]);
  await db.sonarPool.query('delete from contacts where company_id=$1', [
    companyId,
  ]);
  await db.sonarPool.query('delete from campaigns where id=$1', [campaignId]);
  await db.sonarPool.query('delete from companies where id=$1', [companyId]);
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [[accountId, otherAccountId, telegramAccountId]],
  );
  await db.sonarPool.query('delete from users where id=$1', [userId]);
  await tasks.closeTaskQueue();
  await admin.stop();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
