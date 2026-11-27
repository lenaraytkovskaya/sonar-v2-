import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { SocialInboxMessage } from '@sonar/core/social-inbox';
const enabled = process.env.RUN_DB_TESTS === '1';
const testUser = randomUUID();
let db: typeof import('./index.js'),
  inbox: typeof import('./social-inbox.js'),
  tasks: typeof import('./tasks.js');
const accounts: string[] = [],
  companies: string[] = [];
const peer = 'https://www.instagram.com/example_peer/';
const at = '2026-11-14T09:00:00.000Z';
const item = (id = randomUUID()): SocialInboxMessage => ({
  externalMessageId: id,
  threadId: '900000000000005',
  direction: 'out',
  senderPlatformId: '900000000000003',
  peerProfile: peer,
  body: 'Hello',
  occurredAt: at,
  observedAt: at,
});
const save = (accountId: string, messages = [item()]) =>
  inbox.persistSocialInboxBatch(accountId, 'instagram', {
    messages,
    resumeAnchor: { phase: 'after' },
  });
async function account() {
  const id = randomUUID();
  accounts.push(id);
  await db.sonarPool.query(
    'insert into channel_accounts(id,channel,name,address,daily_limit,settings) values($1,\'instagram\',\'S17\',\'\',20,\'{"inboxSync":{"resumeAnchor":{"phase":"before"}}}\')',
    [id],
  );
  return id;
}
async function chat(
  accountId: string,
  thread = '123',
  profile: string | null = null,
  contactId: string | null = null,
) {
  return (
    await db.sonarPool.query(
      "insert into conversations(channel,account_id,provider_thread_id,peer_value,contact_id) values('social',$1,$2,$3,$4) returning id",
      [accountId, thread, profile, contactId],
    )
  ).rows[0].id as string;
}
async function sent(
  conversationId: string,
  accountId: string | null,
  options: {
    to?: string;
    status?: string;
    firstAt?: string | null;
    meta?: unknown;
    externalId?: string | null;
  } = {},
) {
  const id = randomUUID();
  await db.sonarPool.query(
    "insert into messages(id,conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,first_attempt_at,provider_id,social_meta,external_message_id) values($1,$2,$3,'social','out','reply',$4,'','Hello',$5,$1::uuid::text,$6,'https://www.instagram.com/direct/t/123',$7,$8)",
    [
      id,
      conversationId,
      accountId,
      options.to ?? peer,
      options.status ?? 'sent',
      options.firstAt === undefined ? at : options.firstAt,
      options.meta ?? { network: 'instagram', threadId: '123' },
      options.externalId ?? null,
    ],
  );
  return id;
}
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  inbox = await import('./social-inbox.js');
  tasks = await import('./tasks.js');
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'S17','stub')",
    [testUser, `${testUser}@invalid.test`],
  );
  await tasks.boss.start();
  await tasks.boss.createQueue('ai.inbound');
  await tasks.boss.createQueue('form.reply.match');
});
it.skipIf(!enabled)(
  'canonicalizes one proven sent browser conversation, reconciles and resolves its task idempotently',
  async () => {
    const id = await account(),
      v = await chat(id),
      m = await sent(v, id);
    const taskId = randomUUID();
    await db.sonarPool.query(
      "insert into tasks(id,type,idempotency_key,status,reason_code,payload) values($1,'message.send',$1::uuid::text,'paused','social_delivery_uncertain',$2)",
      [taskId, { messageId: m }],
    );
    const message = item();
    expect(await save(id, [message])).toEqual({ created: 0, conflicts: [] });
    expect(await save(id, [message])).toEqual({ created: 0, conflicts: [] });
    expect(
      (
        await db.sonarPool.query(
          'select id,provider_thread_id,peer_value from conversations where account_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([
      { id: v, provider_thread_id: message.threadId, peer_value: peer },
    ]);
    expect(
      (
        await db.sonarPool.query(
          'select id,external_message_id,status,social_meta from messages where conversation_id=$1',
          [v],
        )
      ).rows,
    ).toMatchObject([
      {
        id: m,
        external_message_id: message.externalMessageId,
        status: 'sent',
        social_meta: { threadId: message.threadId },
      },
    ]);
    expect(
      (
        await db.sonarPool.query(
          'select status,reason_code from tasks where id=$1',
          [taskId],
        )
      ).rows[0],
    ).toEqual({ status: 'done', reason_code: null });
  },
);
it
  .skipIf(!enabled)
  .each([
    'mixed_account',
    'unknown_account',
    'different_peer',
    'meta_peer',
    'meta_network',
    'contact_changed',
    'ambiguous',
    'unproven_url',
    'unmarked_binding',
    'unsent_binding',
    'conflicting_urls',
  ] as const)(
  'rejects %s instead of creating or merging a conversation and rolls back the checkpoint',
  async (scenario) => {
    const id = await account(),
      foreign = await account();
    let contactId: string | null = null;
    if (scenario === 'contact_changed') {
      const company = randomUUID();
      companies.push(company);
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1,$1::uuid::text,'S17','PL')",
        [company],
      );
      contactId = (
        await db.sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual') returning id",
          [company, peer],
        )
      ).rows[0].id;
    }
    const v = await chat(id, '123', null, contactId);
    await sent(v, id, {
      firstAt: scenario === 'unmarked_binding' ? null : at,
      status: scenario === 'unsent_binding' ? 'queued' : 'sent',
    });
    if (scenario === 'unmarked_binding' || scenario === 'unsent_binding') {
      /* The guard must see this candidate and reject its missing send proof. */
    } else if (scenario === 'ambiguous') {
      const second = await chat(id, '456');
      await sent(second, id);
    } else if (scenario === 'conflicting_urls') {
      const other = await sent(v, id, { meta: { network: 'instagram' } });
      await db.sonarPool.query(
        "update messages set provider_id='https://www.instagram.com/direct/t/456/' where id=$1",
        [other],
      );
    } else if (scenario === 'unproven_url')
      await db.sonarPool.query(
        "update messages set provider_id='https://www.instagram.com/direct/t/other/' where conversation_id=$1",
        [v],
      );
    else
      await sent(
        v,
        scenario === 'mixed_account'
          ? foreign
          : scenario === 'unknown_account'
            ? null
            : id,
        {
          to: ['different_peer', 'contact_changed'].includes(scenario)
            ? 'https://www.instagram.com/another_peer/'
            : peer,
          meta:
            scenario === 'meta_peer'
              ? {
                  network: 'instagram',
                  peerProfile: 'https://www.instagram.com/another_peer/',
                }
              : scenario === 'meta_network'
                ? { network: 'facebook' }
                : { network: 'instagram' },
        },
      );
    await expect(save(id)).rejects.toThrow(/Перевірте історію вручну/);
    expect(
      (
        await db.sonarPool.query(
          'select provider_thread_id from conversations where id=$1',
          [v],
        )
      ).rows[0].provider_thread_id,
    ).toBe('123');
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int n from conversations where account_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(scenario === 'ambiguous' ? 2 : 1);
    expect(
      (
        await db.sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [id],
        )
      ).rows[0].settings.inboxSync.resumeAnchor,
    ).toEqual({ phase: 'before' });
  },
);
it
  .skipIf(!enabled)
  .each([
    'queued',
    'failed',
    'sent',
    'outside',
    'unmarked',
    'two_attempts',
    'two_captured',
  ] as const)(
  'reconciles only one matching body/time attempt: %s',
  async (scenario) => {
    const id = await account(),
      v = await chat(id, item().threadId, peer);
    const m = await sent(v, id, {
      status: ['queued', 'failed'].includes(scenario) ? scenario : 'sent',
      firstAt:
        scenario === 'outside'
          ? '2026-11-13T00:00:00.000Z'
          : scenario === 'unmarked'
            ? null
            : at,
      meta: { network: 'instagram' },
    });
    if (scenario === 'two_attempts')
      await sent(v, id, { meta: { network: 'instagram' } });
    const messages = scenario === 'two_captured' ? [item(), item()] : [item()];
    const reconciled = ['queued', 'failed', 'sent'].includes(scenario);
    expect((await save(id, messages)).created).toBe(
      reconciled ? 0 : messages.length,
    );
    expect(
      (
        await db.sonarPool.query(
          'select external_message_id from messages where id=$1',
          [m],
        )
      ).rows[0].external_message_id,
    ).toBe(reconciled ? messages[0]!.externalMessageId : null);
  },
);
it.skipIf(!enabled)(
  'keeps existing canonical A/B separate and serializes concurrent new imports',
  async () => {
    const id = await account(),
      a = await chat(id),
      b = await chat(id, item().threadId, peer);
    await sent(a, id);
    await save(id);
    expect(
      (
        await db.sonarPool.query(
          'select id from conversations where account_id=$1',
          [id],
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await db.sonarPool.query(
          'select provider_thread_id from conversations where id=$1',
          [a],
        )
      ).rows[0].provider_thread_id,
    ).toBe('123');
    expect(
      (
        await db.sonarPool.query(
          'select conversation_id from messages where external_message_id is not null and account_id=$1',
          [id],
        )
      ).rows[0].conversation_id,
    ).toBe(b);
    const fresh = await account();
    await Promise.all([save(fresh), save(fresh)]);
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int n from conversations where account_id=$1',
          [fresh],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
it.skipIf(!enabled).each([
  { audited: true, manual: false },
  { audited: false, manual: false },
  { audited: true, manual: true },
  { audited: false, manual: true },
])(
  'preserves only audited local drafts/manual records in a proven receiving chat: $audited/$manual',
  async ({ audited, manual }) => {
    const id = await account();
    const incoming = {
      ...item(),
      direction: 'in' as const,
      senderProfile: peer,
    };
    await save(id, [incoming]);
    const v = (
      await db.sonarPool.query(
        'select id from conversations where account_id=$1',
        [id],
      )
    ).rows[0].id;
    const { saveReplyDraft, queueConversationReply } =
      await import('./inbound.js');
    const draft = manual
      ? await queueConversationReply(
          {
            conversationId: v,
            body: 'Manual record',
            requestId: randomUUID(),
            socialDelivery: 'manual',
          },
          testUser,
        )
      : await saveReplyDraft(v, { body: 'Draft reply' }, randomUUID());
    if (!audited)
      await db.sonarPool.query(
        "delete from activity_log where action in ('message.reply.drafted','message.reply.queued') and details->>'messageId'=$1",
        [draft.id],
      );
    if (audited) {
      await save(id, [incoming]);
      expect(
        (
          await db.sonarPool.query(
            'select account_id,status from messages where id=$1',
            [draft.id],
          )
        ).rows[0],
      ).toEqual({
        account_id: manual ? null : id,
        status: manual ? 'sent' : 'draft',
      });
    } else
      await expect(save(id, [incoming])).rejects.toThrow(
        /Перевірте історію вручну/,
      );
  },
);
afterAll(async () => {
  if (!enabled) return;
  await db.sonarPool.query(
    "delete from tasks where payload->>'messageId' in(select id::text from messages where conversation_id in(select id from conversations where account_id=any($1::uuid[])))",
    [accounts],
  );
  await db.sonarPool.query(
    'delete from messages where conversation_id in(select id from conversations where account_id=any($1::uuid[]))',
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
  await db.sonarPool.query('delete from users where id=$1', [testUser]);
  await tasks.closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
