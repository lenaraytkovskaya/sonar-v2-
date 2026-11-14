import { randomUUID } from 'node:crypto';
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
          await c.query(
            "update messages set social_meta=coalesce(social_meta,'{}'::jsonb)||$2::jsonb where id=$1",
            [prior.id, JSON.stringify({ ...message, network })],
          );
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
        }
        continue;
      }
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `social-thread:${accountId}:${message.threadId}`,
      ]);
      const {
        rows: [existing],
      } = await c.query(
        "select * from conversations where channel='social' and account_id=$1 and provider_thread_id=$2",
        [accountId, message.threadId],
      );
      let conversation = existing;
      if (
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
        values($1,$2,'social',$3,$4,$5,'',$6,$7,$8,$9,$10,$11,case when $3='out' then $11::timestamptz end,$12,$13) returning id`,
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
          message.occurredAt,
          legacy.length > 0,
          legacy.length
            ? 'Можливий збіг зі старим повідомленням без ID. Перевірте чат вручну.'
            : null,
        ],
      );
      created++;
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
      "select id,settings from channel_accounts where channel in ('instagram','facebook','linkedin') and status='active' and settings->>'sessionStatus'='valid'",
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
