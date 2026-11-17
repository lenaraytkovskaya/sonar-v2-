import { enqueueFormReplyMatch } from './form-replies.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SocialNetwork } from '@sonar/core';
import {
  canonicalSocialPeer,
  socialPeerHandle,
  validateSocialInboxMessage,
  type SocialInboxBatch,
  type SocialInboxCheckpoint,
} from '@sonar/core/social-inbox';
import { transaction } from './email.js';
import { enqueueTask, logActivity } from './tasks.js';

export const emptySocialCheckpoint = (): SocialInboxCheckpoint => ({
  watermark: null,
  resumeAnchor: null,
  cycleStartedAt: null,
});

/** Current contacts are routing hints, never proof that an old dialog belongs
 * to this account/peer. Every historical message must agree before any reuse. */
export async function assertFacebookBinding(
  c: PoolClient,
  conversationId: string,
  accountId: string,
  peer: string,
  threadId: string,
) {
  const fail = () => {
    throw new Error(
      'Не підтверджено акаунт або співрозмовник діалогу Facebook. Перевірте історію вручну.',
    );
  };
  const matches = (value: unknown) => {
    if (value === null || value === undefined || value === '') return false;
    if (typeof value !== 'string' || !value.trim()) return fail();
    try {
      if (canonicalSocialPeer('facebook', value) !== peer) fail();
    } catch {
      fail();
    }
    return true;
  };
  const {
    rows: [v],
  } = await c.query(
    'select channel,account_id,peer_value,provider_thread_id,company_id from conversations where id=$1 for update',
    [conversationId],
  );
  if (
    !v ||
    v.channel !== 'social' ||
    (v.account_id !== null && v.account_id !== accountId) ||
    (v.provider_thread_id !== null && v.provider_thread_id !== threadId)
  )
    fail();
  let accountProven = v.account_id === accountId,
    peerProven = matches(v.peer_value);
  const { rows: history } = await c.query<{
    id: string;
    source: string;
    status: string;
    idempotency_key: string;
    external_message_id: string | null;
    provider_id: string | null;
    draftReceipt: boolean;
    channel: string;
    account_id: string | null;
    direction: string;
    to_value: string | null;
    social_meta: Record<string, unknown> | null;
  }>(
    `select m.id,m.source,m.status,m.idempotency_key,m.external_message_id,m.provider_id,m.channel,m.account_id,m.direction,m.to_value,m.social_meta,
    case when m.account_id is null and m.direction='out' and m.source='manual' and m.status='draft' then exists(select 1 from activity_log l where l.action='message.reply.drafted' and l.user_id is null and l.details->>'messageId'=m.id::text
      and ((l.entity_type='conversation' and l.entity_id=$1::text) or (l.entity_type='company' and l.entity_id=$2::text))) else false end as "draftReceipt"
    from messages m where m.conversation_id=$1::uuid for update`,
    [conversationId, v.company_id],
  );
  const repairs: string[] = [];
  const receivingProof =
    v.account_id === accountId &&
    v.provider_thread_id === threadId &&
    matches(v.peer_value) &&
    history.some(
      (row) =>
        row.account_id === accountId &&
        row.direction === 'in' &&
        row.external_message_id &&
        row.social_meta?.network === 'facebook' &&
        row.social_meta?.threadId === threadId,
    );
  for (const row of history) {
    const localDraft =
      row.account_id === null &&
      receivingProof &&
      row.direction === 'out' &&
      row.source === 'manual' &&
      row.status === 'draft' &&
      row.external_message_id === null &&
      row.provider_id === null &&
      /^reply\.draft:[0-9a-f-]{36}$/i.test(row.idempotency_key) &&
      row.draftReceipt;
    if (
      row.channel !== 'social' ||
      (row.account_id !== accountId && !localDraft)
    )
      fail();
    if (localDraft) repairs.push(row.id);
    accountProven = true;
    const meta = row.social_meta;
    if (meta !== null && (typeof meta !== 'object' || Array.isArray(meta)))
      fail();
    if (
      (meta?.network !== undefined && meta.network !== 'facebook') ||
      (meta?.threadId !== undefined && meta.threadId !== threadId)
    )
      fail();
    const evidence = [
      row.to_value,
      meta?.peerProfile,
      ...(row.direction === 'in' ? [meta?.senderProfile] : []),
    ];
    let messagePeerProven = false;
    for (const value of evidence) {
      if (value !== null && value !== undefined && value !== '')
        messagePeerProven = matches(value) || messagePeerProven;
    }
    if (!messagePeerProven) fail();
    peerProven = true;
  }
  if (!accountProven || !peerProven) fail();
  // Only code-created unsent drafts with a matching audit receipt are repaired,
  // after every account/peer check passes. Sent or unaudited NULL rows stay blocked.
  if (repairs.length)
    await c.query(
      'update messages set account_id=$2 where id=any($1::uuid[]) and account_id is null',
      [repairs, accountId],
    );
}

/** Persist only observed precedence edges. Ties between disconnected windows
 * use the previous display order; later overlap may resolve them without dates. */
async function orderFacebookConversation(
  c: PoolClient,
  conversationId: string,
  observed: Map<string, number>,
) {
  const { rows } = await c.query<{
    id: string;
    social_meta: { facebookInboxAfter?: string[] } | null;
  }>(
    `select id,social_meta from messages where conversation_id=$1
    order by (social_meta->>'facebookInboxOrder')::int nulls last,created_at,(social_meta->>'providerOrder')::int nulls first,id`,
    [conversationId],
  );
  const indices = new Map(rows.map((row, index) => [row.id, index]));
  const after = rows.map(
    (row) =>
      new Set(
        (row.social_meta?.facebookInboxAfter ?? []).filter((id) =>
          indices.has(id),
        ),
      ),
  );
  const snapshot = [...observed].sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < snapshot.length; i++) {
    if (snapshot[i - 1]![1] === snapshot[i]![1])
      throw new Error('Неоднозначний порядок повідомлень Facebook.');
    after[indices.get(snapshot[i]![0])!]!.add(snapshot[i - 1]![0]);
  }
  const edges = rows.map(() => new Set<number>()),
    incoming = rows.map(() => 0);
  after.forEach((ids, to) =>
    ids.forEach((id) => {
      const from = indices.get(id)!;
      edges[from]!.add(to);
      incoming[to] = incoming[to]! + 1;
    }),
  );
  // A min-heap keeps the previous order for unconstrained messages in O(n log n).
  const ready: number[] = [];
  const push = (value: number) => {
    let i = ready.length;
    ready.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (ready[parent]! <= value) break;
      ready[i] = ready[parent]!;
      i = parent;
    }
    ready[i] = value;
  };
  const pop = () => {
    const first = ready[0]!,
      last = ready.pop()!;
    if (ready.length) {
      let i = 0;
      while (i * 2 + 1 < ready.length) {
        let child = i * 2 + 1;
        if (child + 1 < ready.length && ready[child + 1]! < ready[child]!)
          child++;
        if (ready[child]! >= last) break;
        ready[i] = ready[child]!;
        i = child;
      }
      ready[i] = last;
    }
    return first;
  };
  incoming.forEach((count, index) => {
    if (!count) push(index);
  });
  const ordered: number[] = [];
  while (ready.length) {
    const index = pop();
    ordered.push(index);
    for (const to of edges[index]!) {
      incoming[to] = incoming[to]! - 1;
      if (!incoming[to]) push(to);
    }
  }
  if (ordered.length !== rows.length)
    throw new Error(
      'Суперечливий порядок повідомлень Facebook. Перевірте чат вручну.',
    );
  await c.query(
    `update messages m set social_meta=coalesce(m.social_meta,'{}'::jsonb)||jsonb_build_object('facebookInboxOrder',x.rank,'facebookInboxAfter',x.after)
    from jsonb_to_recordset($1::jsonb) as x(id uuid,rank int,after jsonb) where m.id=x.id`,
    [
      JSON.stringify(
        ordered.map((index, rank) => ({
          id: rows[index]!.id,
          rank,
          after: [...after[index]!],
        })),
      ),
    ],
  );
}

/** One committed page per callback. Never infer identity from body/time. */
export async function persistSocialInboxBatch(
  accountId: string,
  network: SocialNetwork,
  batch: SocialInboxBatch,
) {
  const messages = batch.messages.map((message) =>
    validateSocialInboxMessage(network, message),
  );
  if (
    JSON.stringify(batch.resumeAnchor).length > 16000 ||
    (batch.resumeAnchor !== null &&
      (typeof batch.resumeAnchor !== 'object' ||
        Array.isArray(batch.resumeAnchor)))
  )
    throw new Error('Некоректна точка продовження синхронізації.');
  return transaction(async (c) => {
    const {
      rows: [account],
    } = await c.query(
      'select id from channel_accounts where id=$1 and channel=$2',
      [accountId, network],
    );
    if (!account) throw new Error('Акаунт соцмережі не знайдено.');
    if (network === 'facebook')
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `facebook-inbox-order:${accountId}`,
      ]);
    const checkedBindings = new Set<string>();
    const guardBinding = async (
      conversationId: string,
      message: (typeof messages)[number],
    ) => {
      if (network !== 'facebook') return;
      const key = JSON.stringify([
        conversationId,
        message.peerProfile,
        message.threadId,
      ]);
      if (checkedBindings.has(key)) return;
      await assertFacebookBinding(
        c,
        conversationId,
        accountId,
        message.peerProfile,
        message.threadId,
      );
      checkedBindings.add(key);
    };
    const observations = new Map<string, Map<string, number>>();
    const observe = (
      conversationId: string,
      id: string,
      message: (typeof messages)[number],
    ) => {
      if (network !== 'facebook' || message.providerOrder === undefined) return;
      const group =
        observations.get(conversationId) ?? new Map<string, number>();
      if (group.has(id) && group.get(id) !== message.providerOrder)
        throw new Error('Неоднозначний порядок повідомлень Facebook.');
      group.set(id, message.providerOrder);
      observations.set(conversationId, group);
    };
    let created = 0;
    const conflicts: string[] = [];
    for (const message of messages) {
      const key = `social:${JSON.stringify([network, accountId, message.externalMessageId])}`;
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        key,
      ]);
      const {
        rows: [prior],
      } = await c.query(
        "select id,direction,social_meta,conversation_id from messages where channel='social' and account_id=$1 and external_message_id=$2 and social_meta->>'network'=$3",
        [accountId, message.externalMessageId, network],
      );
      if (prior) {
        // Binding may already exist or be rejected; never rely on its conditional UPDATE for a lock.
        // Later inserts in this page may need this conversation's FK after the message refresh.
        await c.query('select id from conversations where id=$1 for update', [
          prior.conversation_id,
        ]);
        await guardBinding(prior.conversation_id, message);
        if (
          prior.direction !== message.direction ||
          (prior.social_meta?.threadId &&
            prior.social_meta.threadId !== message.threadId) ||
          (prior.social_meta?.peerProfile &&
            prior.social_meta.peerProfile !== message.peerProfile)
        ) {
          conflicts.push(prior.id);
          await c.query(
            "update messages set needs_human=true,reason_uk='Конфлікт ID повідомлення соцмережі. Перевірте чат вручну.' where id=$1",
            [prior.id],
          );
          await logActivity(
            'social.inbox.identity_conflict',
            'message',
            prior.id,
            null,
            { externalMessageId: message.externalMessageId },
            c,
          );
        } else {
          // Attach a pre-sync sender row to the provider thread when unambiguous.
          await c.query(
            `update conversations v set provider_thread_id=$2,account_id=$3,peer_value=$4
            where v.id=$1 and v.provider_thread_id is null and not exists(
              select 1 from conversations where channel='social' and account_id=$3 and provider_thread_id=$2)`,
            [
              prior.conversation_id,
              message.threadId,
              accountId,
              message.peerProfile,
            ],
          );
          observe(prior.conversation_id, prior.id, message);
          const occurredAt =
            message.occurredAt ?? prior.social_meta?.occurredAt ?? null;
          await c.query(
            `update messages set
              created_at=case when social_meta->'occurredAt'='null'::jsonb and $3::timestamptz is not null then $3::timestamptz else created_at end,
              sent_at=case when direction='out' and social_meta->'occurredAt'='null'::jsonb and $3::timestamptz is not null then $3::timestamptz else sent_at end,
              social_meta=coalesce(social_meta,'{}'::jsonb)||$2::jsonb where id=$1`,
            [
              prior.id,
              JSON.stringify({ ...message, occurredAt, network }),
              occurredAt,
            ],
          );
        }
        continue;
      }
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `social-thread:${accountId}:${message.threadId}`,
      ]);
      const {
        rows: [existing],
      } = await c.query(
        "select * from conversations where channel='social' and account_id=$1 and provider_thread_id=$2 for update",
        [accountId, message.threadId],
      );
      let conversation = existing;
      if (
        network !== 'facebook' &&
        conversation &&
        canonicalSocialPeer(network, conversation.peer_value) !==
          message.peerProfile
      )
        throw new Error(
          'Змінився співрозмовник діалогу. Перевірте чат вручну.',
        );
      if (!conversation) {
        const handle = socialPeerHandle(message.peerProfile).toLowerCase();
        const { rows: contacts } = await c.query(
          "select id,company_id,normalized,meta from contacts where kind='social' order by id",
        );
        const candidates = contacts.filter((contact) => {
          try {
            return (
              canonicalSocialPeer(network, contact.normalized) ===
              message.peerProfile
            );
          } catch {
            return (
              contact.meta?.network === network &&
              contact.normalized.replace(/^@/, '').toLowerCase() === handle
            );
          }
        });
        const companyId =
          new Set(candidates.map((contact) => contact.company_id)).size === 1
            ? candidates[0]?.company_id
            : null;
        const {
          rows: [campaign],
        } = companyId
          ? await c.query(
              'select campaign_id from campaign_companies where company_id=$1 order by added_at desc,campaign_id limit 1',
              [companyId],
            )
          : { rows: [] };
        const { rows: unbound } = await c.query(
          `select v.* from conversations v where v.channel='social' and v.provider_thread_id is null
          and (v.account_id=$1 or (v.account_id is null and exists(select 1 from messages m where m.conversation_id=v.id and m.account_id=$1)))
          and (v.peer_value=$2 or v.contact_id=any($3::uuid[]))
          and ($4::boolean or not exists(select 1 from messages m where m.conversation_id=v.id and m.account_id is not null and m.account_id<>$1)) for update`,
          [
            accountId,
            message.peerProfile,
            candidates.map((contact) => contact.id),
            network === 'facebook',
          ],
        );
        for (const row of unbound) await guardBinding(row.id, message);
        if (network === 'facebook' && unbound.length > 1)
          throw new Error(
            'Неоднозначна прив’язка діалогу Facebook. Перевірте історію вручну.',
          );
        if (unbound.length === 1) {
          conversation = (
            await c.query(
              'update conversations set account_id=$2,provider_thread_id=$3,peer_value=$4 where id=$1 returning *',
              [unbound[0].id, accountId, message.threadId, message.peerProfile],
            )
          ).rows[0];
        } else {
          const {
            rows: [inserted],
          } = await c.query(
            "insert into conversations(channel,account_id,provider_thread_id,peer_value,company_id,contact_id,campaign_id) values('social',$1,$2,$3,$4,$5,$6) returning *",
            [
              accountId,
              message.threadId,
              message.peerProfile,
              companyId ?? null,
              companyId ? candidates[0]!.id : null,
              campaign?.campaign_id ?? null,
            ],
          );
          conversation = inserted;
        }
      }
      await guardBinding(conversation.id, message);
      // Old locally sent rows lack external IDs. Preserve both observations and
      // flag the collision for a person; body/time are never deduplication keys.
      const { rows: legacy } =
        message.direction === 'out'
          ? await c.query(
              "select m.id from messages m left join conversations v on v.id=m.conversation_id where m.channel='social' and m.account_id=$1 and m.direction='out' and m.external_message_id is null and m.body=$2 and (m.to_value=$3 or v.peer_value=$3) and m.status in ('sent','delivered','read')",
              [accountId, message.body, message.peerProfile],
            )
          : { rows: [] };
      const meta = {
        ...message,
        network,
        ...(legacy.length
          ? { legacyConflictIds: legacy.map((row) => row.id) }
          : {}),
      };
      const {
        rows: [inserted],
      } = await c.query(
        `insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,external_message_id,social_meta,created_at,sent_at,needs_human,reason_uk)
        values($1,$2,'social',$3,$4,$5,'',$6,$7,$8,$9,$10,$11,case when $3='out' then $14::timestamptz end,$12,$13) returning id`,
        [
          conversation.id,
          accountId,
          message.direction,
          message.direction === 'in' ? 'inbound' : 'manual',
          message.peerProfile,
          message.body,
          message.direction === 'in' ? 'delivered' : 'sent',
          key,
          message.externalMessageId,
          meta,
          message.occurredAt ?? message.observedAt,
          legacy.length > 0,
          legacy.length
            ? 'Можливий збіг зі старим повідомленням без ID. Перевірте чат вручну.'
            : null,
          message.occurredAt,
        ],
      );
      created++;
      observe(conversation.id, inserted.id, message);
      if (message.direction === 'in' && !conversation.company_id)
        await enqueueFormReplyMatch(c, conversation.id, inserted.id);
      if (message.direction === 'in')
        await enqueueTask(
          'ai.inbound',
          `ai.inbound:${inserted.id}`,
          { messageId: inserted.id },
          c,
        );
      if (legacy.length) {
        conflicts.push(inserted.id);
        await logActivity(
          'social.inbox.legacy_conflict',
          'message',
          inserted.id,
          null,
          { legacyMessageIds: legacy.map((row) => row.id) },
          c,
        );
      }
    }
    for (const [conversationId, observed] of observations)
      await orderFacebookConversation(c, conversationId, observed);
    await c.query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxSync}',coalesce(settings->'inboxSync','{}'::jsonb)||jsonb_build_object('resumeAnchor',$2::jsonb)) where id=$1",
      [accountId, JSON.stringify(batch.resumeAnchor)],
    );
    return { created, conflicts };
  });
}

/** Single live task per account, including future jobs. Reconciles on startup. */
export async function reconcileSocialInbox(now = new Date()) {
  return transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('social-inbox-reconcile',0))",
    );
    const {
      rows: [enabled],
    } = await c.query(
      "select value from settings where key='social.inbox.enabled'",
    );
    if (enabled?.value !== true) return 0;
    const {
      rows: [pollSetting],
    } = await c.query(
      "select value from settings where key='social.inbox.poll_seconds'",
    );
    if (!Number.isSafeInteger(pollSetting?.value) || pollSetting.value < 1)
      return 0;
    // A killed worker can leave the CRM task running after pg-boss expires it.
    // An expired job whose browser is still alive cannot be replaced until the
    // shared account lock is released.
    await c.query(`update tasks t set status='failed',finished_at=now(),reason_code='social_inbox_interrupted',
      reason_uk='Попередній запуск перервано. Продовження зі збереженої порції.'
      where t.type='social.inbox.sync' and t.status in ('queued','running')
      and not exists(select 1 from pgboss.job j where j.name='social.inbox.sync' and j.data->>'taskId'=t.id::text and j.state in ('created','retry','active'))
      and pg_try_advisory_xact_lock(hashtextextended('channel-account:'||(t.payload->>'accountId'),0))`);
    const { rows: accounts } = await c.query(
      `select id,settings from channel_accounts a where channel in ('instagram','facebook') and status='active' and settings->>'sessionStatus'='valid' and coalesce(settings->>'enabled','true')<>'false' and settings->>'inboxPollingEnabled'='true' and exists(select 1 from settings s where s.key='social.inbox.'||a.channel||'.enabled' and s.value='true'::jsonb)`,
    );
    let count = 0;
    for (const account of accounts) {
      const {
        rows: [pending],
      } = await c.query(
        "select id from tasks where type='social.inbox.sync' and payload->>'accountId'=$1 and status in ('queued','running') limit 1",
        [account.id],
      );
      if (pending) continue;
      const due = Date.parse(account.settings.inboxSync?.nextPollAt ?? '');
      const runAt = new Date(
        Math.max(now.getTime(), Number.isFinite(due) ? due : 0),
      );
      await enqueueTask(
        'social.inbox.sync',
        `social.inbox.sync:${account.id}:${randomUUID()}`,
        { accountId: account.id },
        c,
        runAt,
      );
      count++;
    }
    return count;
  });
}
