import { sonarPool } from './index.js';
import { logActivity } from './tasks.js';
import { transaction } from './email.js';

export type ViberObservedMessage = {
  from: string;
  text: string;
  at: string;
  providerMessageId: string;
};

function normalizeObservedText(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** Repairs only the same uncertain attempt on the account scanned by the bridge. */
export async function reconcileViberDeliveries(
  observed: ViberObservedMessage[],
  now: Date,
  accountId: string,
) {
  return transaction(async (c) => {
    // Share the sender's account lock, including across concurrent inbox polls.
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
      [accountId],
    );
    const { rows } = await c.query<{
      id: string;
      company_id: string | null;
      account_id: string;
      conversation_id: string;
      to_value: string;
      body: string;
      first_attempt_at: Date;
      quota_day: string | null;
      task_id: string;
    }>(
      `select m.*,v.company_id,t.id as task_id from messages m
        join conversations v on v.id=m.conversation_id
        join lateral (select * from tasks where type='message.send'
          and payload->>'messageId'=m.id::text order by created_at desc,id desc limit 1) t on true
        where m.channel='viber' and m.direction='out' and m.status='failed' and m.account_id=$2
          and m.first_attempt_at between $1::timestamptz - interval '30 minutes' and $1::timestamptz
          and m.provider_id is null
          and t.status in ('paused','failed') and t.reason_code='viber_delivery_uncertain'
          and m.request_snapshot->>'idempotencyKey'=m.idempotency_key
          and m.request_snapshot->>'to'=m.to_value and m.request_snapshot->>'body'=m.body
        order by m.first_attempt_at,m.id for update of m`,
      [now, accountId],
    );
    let reconciled = 0;
    const { rows: used } = await c.query<{ provider_id: string }>(
      "select provider_id from messages where channel='viber' and account_id=$1 and direction='out' and provider_id=any($2::text[])",
      [accountId, observed.map((item) => item.providerMessageId)],
    );
    const consumed = new Set(used.map((item) => item.provider_id));
    for (const message of rows) {
      const body = normalizeObservedText(message.body);
      const match = observed.find((item) => {
        const at = new Date(item.at).getTime();
        const earliest = item.providerMessageId.startsWith('screen:')
          ? Math.floor(at / 60_000) * 60_000
          : at;
        return (
          !!item.providerMessageId &&
          !consumed.has(item.providerMessageId) &&
          item.from === message.to_value &&
          !!body &&
          body === normalizeObservedText(item.text) &&
          // A screen minute is its earliest possible time: never round the attempt down.
          earliest >= message.first_attempt_at.getTime() &&
          at <= now.getTime()
        );
      });
      if (!match) continue;
      consumed.add(match.providerMessageId);
      const day = new Date(match.at).toISOString().slice(0, 10);
      await c.query(
        "update messages set status='sent',provider_id=$2,sent_at=$3,reason_uk=null,quota_day=$4 where id=$1",
        [message.id, match.providerMessageId, match.at, day],
      );
      if (message.quota_day !== day)
        await c.query(
          'update channel_accounts set sent_day=$2,attempt_count=case when sent_day=$2 then attempt_count+1 else 1 end where id=$1',
          [accountId, day],
        );
      await c.query(
        "update tasks set status='done',finished_at=$2,reason_code=null,reason_uk=null,result=coalesce(result,'{}'::jsonb)||$3::jsonb where id=$1",
        [
          message.task_id,
          match.at,
          { messageId: message.id, deliveryReconciled: true },
        ],
      );
      await logActivity(
        'viber.delivery.reconciled',
        message.company_id ? 'company' : 'conversation',
        message.company_id ?? message.conversation_id,
        null,
        { messageId: message.id, providerMessageId: match.providerMessageId },
        c,
      );
      reconciled++;
    }
    return reconciled;
  });
}

export async function markViberSentManually(
  messageId: string,
  conversationId: string,
  userId: string,
) {
  return transaction(async (c) => {
    const {
      rows: [message],
    } = await c.query(
      `select m.id,v.company_id,m.conversation_id,m.account_id,m.quota_day,m.status from messages m
        join conversations v on v.id=m.conversation_id
        where m.id=$1 and v.id=$2 and m.channel='viber' and m.direction='out'
        for update of m`,
      [messageId, conversationId],
    );
    if (!message) throw new Error('Повідомлення Viber не знайдено.');
    if (message.status === 'sent') return { id: messageId, status: 'sent' };
    if (message.status !== 'failed')
      throw new Error('Позначити можна лише невизначене повідомлення Viber.');
    const day = new Date().toISOString().slice(0, 10);
    await c.query(
      "update messages set status='sent',sent_at=now(),reason_uk=null,quota_day=$2 where id=$1",
      [messageId, day],
    );
    if (message.quota_day !== day && message.account_id)
      await c.query(
        "update channel_accounts set sent_day=$2,attempt_count=case when sent_day=$2 then attempt_count+1 else 1 end where id=$1 and channel='viber'",
        [message.account_id, day],
      );
    await c.query(
      "update tasks set status='done',finished_at=now(),reason_code=null,reason_uk=null,result=coalesce(result,'{}'::jsonb)||$2::jsonb where type='message.send' and payload->>'messageId'=$1 and status in ('paused','failed')",
      [messageId, { messageId, manuallySent: true }],
    );
    await logActivity(
      'viber.manually_sent',
      message.company_id ? 'company' : 'conversation',
      message.company_id ?? message.conversation_id,
      userId,
      { messageId },
      c,
    );
    return { id: messageId, status: 'sent' };
  });
}

export async function listViberAccounts() {
  const { rows } = await sonarPool.query(
    `select a.id,a.name,a.daily_limit as "dailyLimit",a.status,a.next_send_at as "nextSendAt",
      (select count(*)::int from messages m where m.account_id=a.id and m.direction='out' and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday"
      from channel_accounts a where a.channel='viber' order by a.created_at,a.id limit 1`,
  );
  return rows;
}

export async function updateViberAccount(
  userId: string,
  update: { dailyLimit?: number; paused?: boolean },
) {
  if (
    update.dailyLimit !== undefined &&
    (!Number.isInteger(update.dailyLimit) ||
      update.dailyLimit < 1 ||
      update.dailyLimit > 500)
  )
    throw new Error('Некоректний денний ліміт Viber.');
  return transaction(async (c) => {
    const {
      rows: [account],
    } = await c.query(
      `update channel_accounts set daily_limit=coalesce($1,daily_limit),status=case when $2::boolean is null then status when $2 then 'paused' else 'active' end
        where channel='viber' and owner_id=$3 returning id,daily_limit as "dailyLimit",status`,
      [update.dailyLimit ?? null, update.paused ?? null, userId],
    );
    if (!account)
      throw new Error('Канал Viber доступний лише призначеному власнику.');
    await logActivity(
      'viber.settings.updated',
      'channel_account',
      account.id,
      userId,
      update,
      c,
    );
    return account;
  });
}

/** Assigns an unowned Viber channel only when the CRM owner explicitly connects it. */
export async function claimViberAccount(userId: string) {
  return transaction(async (c) => {
    const {
      rows: [account],
    } = await c.query<{ id: string; owner_id: string | null }>(
      `select id,owner_id from channel_accounts where channel='viber' order by created_at,id limit 1 for update`,
    );
    if (!account) throw new Error('Акаунт Viber не знайдено.');
    if (account.owner_id) {
      if (account.owner_id !== userId)
        throw new Error('Канал Viber доступний лише призначеному власнику.');
      return { id: account.id, ownerId: account.owner_id };
    }

    // This CRM has no role field. The earliest created user is its owner until
    // an explicit role model is introduced.
    const {
      rows: [crmOwner],
    } = await c.query<{ id: string }>(
      'select id from users order by created_at,id limit 1',
    );
    if (!crmOwner || crmOwner.id !== userId)
      throw new Error(
        'Лише власник CRM може призначити власника каналу Viber.',
      );

    const {
      rows: [claimed],
    } = await c.query<{ id: string }>(
      `update channel_accounts set owner_id=$2 where id=$1 and owner_id is null returning id`,
      [account.id, userId],
    );
    if (!claimed)
      throw new Error('Канал Viber доступний лише призначеному власнику.');
    await logActivity(
      'viber.owner.assigned',
      'channel_account',
      account.id,
      userId,
      { ownerId: userId },
      c,
    );
    return { id: claimed.id, ownerId: userId };
  });
}
