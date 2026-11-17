import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let inbound: typeof import('./inbound.js');
let email: typeof import('./email.js');
let admin: import('pg-boss').PgBoss;
const user = randomUUID(),
  account = randomUUID(),
  otherAccount = randomUUID();
const company = randomUUID(),
  campaign = randomUUID(),
  contact = randomUUID();
const linkContact = randomUUID(),
  outgoing = randomUUID(),
  oldPhone = randomUUID();
const phone = '+12025550123',
  lid = 'whatsapp:lid:123456789012345';
let unknown: string, incomingId: string, draftId: string;
const draftTask = randomUUID(),
  secondCompany = randomUUID();
const delivery = {
  channel: 'whatsapp' as const,
  accountId: account,
  providerId: randomUUID(),
  sender: lid,
  body: 'Hello',
};
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  inbound = await import('./inbound.js');
  email = await import('./email.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const name of [
    'form.reply.match',
    'ai.inbound',
    'whatsapp.identity.repair',
    'message.send',
  ])
    await admin.createQueue(name);
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'Identity test','stub')",
    [user, `${user}@example.invalid`],
  );
  // Exercise future/legacy multi-account data without relaxing the production singleton.
  await db.sonarPool.query('drop index channel_accounts_whatsapp_singleton');
  await db.sonarPool.query(
    `insert into channel_accounts(id,name,address,channel,owner_id,daily_limit,settings) values
    ($1,'Identity A','+12025550001','whatsapp',$3,100,'{"session":"default"}'),
    ($2,'Identity B','+12025550002','whatsapp',$3,100,'{"session":"other"}')`,
    [account, otherAccount, user],
  );
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$2,'Identity test','GB')",
    [company, `manual:${company}`],
  );
  await db.sonarPool.query(
    "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Identity test','GB','en','{}','{}','',1,'{\"whatsapp\":true}','{}')",
    [campaign],
  );
  await db.sonarPool.query(
    "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$3,'phone',$4,$4,'manual'),($2,$3,'whatsapp',$5,$5,'manual')",
    [contact, linkContact, company, phone, `https://wa.me/${phone.slice(1)}`],
  );
  await db.sonarPool.query(
    "insert into conversations(id,company_id,campaign_id,contact_id,channel) values($1,$3,$4,$5,'whatsapp'),($2,$3,$4,$6,'whatsapp')",
    [outgoing, oldPhone, company, campaign, linkContact, contact],
  );
  for (const [id, to] of [
    [outgoing, `https://wa.me/${phone.slice(1)}`],
    [oldPhone, phone],
  ])
    await db.sonarPool.query(
      "insert into messages(conversation_id,account_id,channel,to_value,subject,body,status,idempotency_key,provider_id,first_attempt_at,request_snapshot) values($1,$2,'whatsapp',$3,'','Original outgoing','sent',$4,$5,now(),'{\"durable\":true}')",
      [id, account, to, randomUUID(), randomUUID()],
    );
  const received = await inbound.recordInbound(delivery);
  unknown = received.conversationId;
  incomingId = received.messageId;
  await inbound.applyInboundClassification(incomingId, 'question');
  await inbound.markConversationRead(unknown, incomingId);
  draftId = (
    await inbound.saveReplyDraft(
      unknown,
      { body: 'Preserved AI draft' },
      draftTask,
    )
  ).id;
});
it.skipIf(!enabled)(
  'previews and repairs proven LID/phone/link threads without changing durable message or AI state',
  async () => {
    const before = (
      await db.sonarPool.query(
        'select * from messages where conversation_id=any($1::uuid[]) order by id',
        [[outgoing, oldPhone, unknown]],
      )
    ).rows;
    await expect(
      inbound.getWhatsAppRepairPeer(unknown, randomUUID()),
    ).rejects.toThrow();
    const requestId = randomUUID();
    const queued = await inbound.enqueueWhatsAppIdentityRepair(
      unknown,
      user,
      requestId,
      true,
    );
    expect(
      await inbound.enqueueWhatsAppIdentityRepair(
        unknown,
        user,
        requestId,
        true,
      ),
    ).toEqual(queued);
    await expect(
      inbound.enqueueWhatsAppIdentityRepair(unknown, user, requestId, false),
    ).rejects.toThrow();
    const proposal = await inbound.repairWhatsAppIdentity(
      unknown,
      user,
      phone,
      true,
    );
    expect(proposal.ambiguous).toBe(false);
    expect(proposal.mergedIds).toHaveLength(2);
    expect(
      (
        await db.sonarPool.query(
          'select merged_into_id from conversations where id=$1',
          [unknown],
        )
      ).rows[0].merged_into_id,
    ).toBeNull();
    const result = await inbound.repairWhatsAppIdentity(
      unknown,
      user,
      phone,
      false,
    );
    const target = result.conversationId!;
    expect([outgoing, oldPhone]).toContain(target);
    const after = (
      await db.sonarPool.query(
        'select * from messages where conversation_id=$1 order by id',
        [target],
      )
    ).rows;
    expect(after.map((row) => ({ ...row, conversation_id: target }))).toEqual(
      before.map((row) => ({ ...row, conversation_id: target })),
    );
    await expect(
      db.sonarPool.query(
        "update messages set body='Changed' where conversation_id=$1 and first_attempt_at is not null",
        [target],
      ),
    ).rejects.toThrow('immutable');
    expect((await inbound.getConversationChat(unknown)).conversation?.id).toBe(
      target,
    );
    expect(
      (
        await inbound.saveReplyDraft(
          unknown,
          { body: 'Preserved AI draft' },
          draftTask,
        )
      ).id,
    ).toBe(draftId);
    const again = await inbound.repairWhatsAppIdentity(
      unknown,
      user,
      phone,
      false,
    );
    expect(again.mergedIds).toEqual([]);
    const request = {
      conversationId: unknown,
      body: 'Owned reply',
      requestId: randomUUID(),
    };
    const [replyA, replyB] = await Promise.all([
      inbound.queueConversationReply(request, user),
      inbound.queueConversationReply(request, user),
      inbound.repairWhatsAppIdentity(unknown, user, phone, false),
    ]);
    expect(replyA.id).toBe(replyB.id);
    expect(
      (
        await db.sonarPool.query(
          'select account_id,conversation_id from messages where id=$1',
          [replyA.id],
        )
      ).rows[0],
    ).toEqual({ account_id: account, conversation_id: target });
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='message.send' and payload->>'messageId'=$1",
          [replyA.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      db.sonarPool.query(
        'update messages set conversation_id=$2 where conversation_id=$1 and first_attempt_at is not null',
        [target, unknown],
      ),
    ).rejects.toThrow('immutable');
    const received = await Promise.all([
      inbound.recordInbound({
        ...delivery,
        providerId: 'concurrent-new',
        senderPhone: phone,
      }),
      inbound.recordInbound({
        ...delivery,
        providerId: 'concurrent-new',
        senderPhone: phone,
      }),
      inbound.repairWhatsAppIdentity(unknown, user, phone, false),
    ]);
    expect(received[0]).toMatchObject({ conversationId: target });
    expect(received[1]).toMatchObject({
      conversationId: target,
      messageId: received[0].messageId,
    });
    expect(
      (
        await db.sonarPool.query(
          "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId'=any($1::text[])",
          [[incomingId, received[0].messageId]],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await db.sonarPool.query(
          'select read_at,classification,needs_human from messages where id=$1',
          [incomingId],
        )
      ).rows[0],
    ).toMatchObject({
      read_at: expect.any(Date),
      classification: 'question',
      needs_human: true,
    });
  },
);
it.skipIf(!enabled)(
  'keeps accounts separate and propagates refusal across every proven alias',
  async () => {
    const other = await inbound.recordInbound({
      ...delivery,
      accountId: otherAccount,
      sender: phone,
      providerId: 'other-account',
    });
    const first = await inbound.getConversationChat(unknown);
    expect(other.conversationId).not.toBe(first.conversation!.id);
    expect(other.companyId).toBe(company);
    await inbound.applyInboundClassification(incomingId, 'refusal'); // already classified; idempotent
    const refusal = await inbound.recordInbound({
      ...delivery,
      providerId: 'refusal',
      body: 'Stop',
    });
    await inbound.applyInboundClassification(refusal.messageId, 'refusal');
    expect(await email.isContactBlocked(db.sonarPool, company, phone)).toBe(
      true,
    );
    expect(await email.isContactBlocked(db.sonarPool, null, lid)).toBe(true);
    expect(
      await email.isContactBlocked(
        db.sonarPool,
        null,
        `https://wa.me/${phone.slice(1)}`,
      ),
    ).toBe(true);
    await Promise.all([
      inbound.repairWhatsAppIdentity(unknown, user, phone, false),
      email.blockCompany(company, user),
    ]);
    await expect(
      inbound.queueConversationReply(
        { conversationId: unknown, body: 'Blocked', requestId: randomUUID() },
        user,
      ),
    ).rejects.toThrow();
  },
);
it.skipIf(!enabled)(
  'leaves missing or contradictory mappings unknown and never chooses between companies',
  async () => {
    const opaque = `whatsapp:lid:999999999999999`;
    const missing = await inbound.recordInbound({
      ...delivery,
      sender: opaque,
      providerId: 'missing-mapping',
    });
    expect(missing.companyId).toBeNull();
    const ownMapping = await inbound.recordInbound({
      ...delivery,
      sender: 'whatsapp:lid:777777777777777',
      senderPhone: '+12025550001',
      providerId: 'own-phone-mapping',
    });
    expect(ownMapping.companyId).toBeNull();
    expect(
      (
        await inbound.repairWhatsAppIdentity(
          ownMapping.conversationId,
          user,
          '+12025550001',
          false,
        )
      ).ambiguous,
    ).toBe(true);
    const secondThread = randomUUID();
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$2,'Ambiguous test','GB')",
      [secondCompany, `manual:${secondCompany}`],
    );
    await db.sonarPool.query(
      "insert into conversations(id,channel,account_id,company_id,peer_value) values($1,'whatsapp',$2,$3,$4)",
      [secondThread, account, secondCompany, phone],
    );
    const result = await inbound.repairWhatsAppIdentity(
      missing.conversationId,
      user,
      phone,
      false,
    );
    expect(result.ambiguous).toBe(true);
    const unchanged = (
      await inbound.getConversationChat(missing.conversationId)
    ).conversation!;
    expect(unchanged.id).toBe(missing.conversationId);
    expect(unchanged.companyId).toBeNull();
    const next = await inbound.recordInbound({
      ...delivery,
      sender: opaque,
      senderPhone: phone,
      providerId: 'ambiguous-next',
    });
    expect(next.conversationId).toBe(missing.conversationId);
    expect(next.companyId).toBeNull();
  },
);
it.skipIf(!enabled)(
  'links a formerly unknown LID only after a unique contact mapping becomes available',
  async () => {
    const nextPhone = '+12025550124',
      nextLid = 'whatsapp:lid:888888888888888';
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'phone',$2,$2,'manual')",
      [company, nextPhone],
    );
    const received = await inbound.recordInbound({
      ...delivery,
      sender: nextLid,
      providerId: 'later-mapping',
    });
    expect(received.companyId).toBeNull();
    await inbound.repairWhatsAppIdentity(
      received.conversationId,
      user,
      nextPhone,
      false,
    );
    expect(
      (await inbound.getConversationChat(received.conversationId)).conversation
        ?.companyId,
    ).toBe(company);
    expect(await email.isContactBlocked(db.sonarPool, null, nextPhone)).toBe(
      true,
    );
  },
);
afterAll(async () => {
  if (!enabled) return;
  // The runner provisions a disposable PostgreSQL container; no development database is used.
  const { rows } = await db.sonarPool.query(
    'select id from conversations where company_id=any($1::uuid[]) or account_id=any($2::uuid[])',
    [
      [company, secondCompany],
      [account, otherAccount],
    ],
  );
  const ids = rows.map((r) => r.id);
  await db.sonarPool.query(
    "delete from tasks where payload->>'conversationId'=any($1::text[]) or payload->>'messageId' in(select id::text from messages where conversation_id=any($2::uuid[]))",
    [ids, ids],
  );
  await db.sonarPool.query(
    'delete from activity_log where entity_id=any($1::text[]) or user_id=$2',
    [ids.concat([company, secondCompany]), user],
  );
  await db.sonarPool.query(
    'delete from do_not_contact where company_id=any($1::uuid[]) or value_normalized=any($2::text[])',
    [
      [company, secondCompany],
      [phone, lid],
    ],
  );
  await db.sonarPool.query(
    'delete from messages where conversation_id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'update conversations set merged_into_id=null where id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'delete from conversations where id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query('delete from contacts where company_id=$1', [
    company,
  ]);
  await db.sonarPool.query('delete from campaigns where id=$1', [campaign]);
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    [company, secondCompany],
  ]);
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [[account, otherAccount]],
  );
  await db.sonarPool.query('delete from users where id=$1', [user]);
  await db.sonarPool.query(
    "create unique index channel_accounts_whatsapp_singleton on channel_accounts(channel) where channel='whatsapp'",
  );
  await (await import('./tasks.js')).closeTaskQueue();
  await admin.stop();
  await db.sonarPool.end();
  await db.registryPool.end();
});
