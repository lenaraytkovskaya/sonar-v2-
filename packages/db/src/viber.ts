import { sonarPool } from './index.js';
import { logActivity } from './tasks.js';
import { transaction } from './email.js';

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
