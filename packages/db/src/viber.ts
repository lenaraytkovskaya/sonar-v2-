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
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('uk')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function observedTextSimilarity(left: string, right: string) {
  const a = normalizeObservedText(Array.from(left).slice(0, 60).join(''));
  const b = normalizeObservedText(right);
  if (!a || !b) return a === b ? 1 : 0;
  let best = 0;
  for (
    let size = Math.max(1, Math.floor(a.length * 0.8));
    size <= Math.min(b.length, Math.ceil(a.length * 1.2));
    size++
  ) {
    for (let start = 0; start + size <= b.length; start++) {
      const candidate = b.slice(start, start + size);
      const previous = Array.from(
        { length: candidate.length + 1 },
        (_, index) => index,
      );
      for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0]!;
        previous[0] = i;
        for (let j = 1; j <= candidate.length; j++) {
          const above = previous[j]!;
          previous[j] = Math.min(
            previous[j]! + 1,
            previous[j - 1]! + 1,
            diagonal + (a[i - 1] === candidate[j - 1] ? 0 : 1),
          );
          diagonal = above;
        }
      }
      best = Math.max(
        best,
        1 - previous[candidate.length]! / Math.max(a.length, candidate.length),
      );
    }
  }
  return best;
}

/** Repairs only recently failed Viber sends that match an observed outbound message. */
export async function reconcileViberDeliveries(
  observed: ViberObservedMessage[],
  now = new Date(),
) {
  const { rows } = await sonarPool.query<{
    id: string;
    company_id: string | null;
    account_id: string | null;
    conversation_id: string;
    to_value: string;
    body: string;
    first_attempt_at: Date | null;
    created_at: Date;
  }>(
    `select m.id,v.company_id,m.account_id,m.conversation_id,m.to_value,m.body,m.first_attempt_at,m.created_at from messages m
      join conversations v on v.id=m.conversation_id
      where m.channel='viber' and m.direction='out' and m.status='failed'
        and m.created_at >= $1::timestamptz - interval '2 minutes'
        and m.created_at <= $1::timestamptz`,
    [now],
  );
  let reconciled = 0;
  for (const message of rows) {
    const match = observed.find((item) => {
      const at = new Date(item.at);
      const attemptedAt = message.first_attempt_at ?? message.created_at;
      const minutePrecision = item.providerMessageId.startsWith('screen:');
      const earliest = minutePrecision
        ? Math.floor(attemptedAt.getTime() / 60_000) * 60_000
        : attemptedAt.getTime();
      return (
        item.from === message.to_value &&
        observedTextSimilarity(message.body, item.text) >= 0.8 &&
        Number.isFinite(at.getTime()) &&
        at.getTime() >= earliest &&
        at.getTime() <= now.getTime() + 60_000
      );
    });
    if (!match) continue;
    const changed = await transaction(async (c) => {
      const {
        rows: [locked],
      } = await c.query(
        `select m.id,v.company_id,m.account_id,m.conversation_id,m.quota_day from messages m
          join conversations v on v.id=m.conversation_id
          where m.id=$1 and m.channel='viber' and m.direction='out' and m.status='failed'
          for update of m`,
        [message.id],
      );
      if (!locked) return false;
      const day = new Date(match.at).toISOString().slice(0, 10);
      await c.query(
        "update messages set status='sent',provider_id=$2,sent_at=$3,reason_uk=null,quota_day=$4 where id=$1",
        [message.id, match.providerMessageId, match.at, day],
      );
      if (locked.quota_day !== day && locked.account_id)
        await c.query(
          'update channel_accounts set sent_day=$2,attempt_count=case when sent_day=$2 then attempt_count+1 else 1 end where id=$1',
          [locked.account_id, day],
        );
      await c.query(
        "update tasks set status='done',finished_at=$2,reason_code=null,reason_uk=null,result=coalesce(result,'{}'::jsonb)||$3::jsonb where type='message.send' and payload->>'messageId'=$1 and status in ('paused','failed')",
        [
          message.id,
          match.at,
          { messageId: message.id, deliveryReconciled: true },
        ],
      );
      await logActivity(
        'viber.delivery.reconciled',
        locked.company_id ? 'company' : 'conversation',
        locked.company_id ?? locked.conversation_id,
        null,
        { messageId: message.id, providerMessageId: match.providerMessageId },
        c,
      );
      return true;
    });
    if (changed) reconciled++;
  }
  return reconciled;
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
        where channel='viber' returning id,daily_limit as "dailyLimit",status`,
      [update.dailyLimit ?? null, update.paused ?? null],
    );
    if (!account) throw new Error('Акаунт Viber не знайдено.');
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
