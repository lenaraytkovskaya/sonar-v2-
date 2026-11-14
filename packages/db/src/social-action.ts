import type { PoolClient } from 'pg';

/** Caller holds channel-account:<id>. Shared spacing, independent daily counters. */
export async function reserveSocialAction(
  c: PoolClient,
  accountId: string,
  action: 'send' | 'sync' | 'fetch' | 'check',
  now: Date,
  dailyLimit?: number,
): Promise<Date | null> {
  const {
    rows: [account],
  } = await c.query(
    'select settings from channel_accounts where id=$1 for update',
    [accountId],
  );
  if (!account) throw new Error('Unknown social account');
  const {
    rows: [setting],
  } = await c.query(
    "select value from settings where key='social.action.min_gap_seconds'",
  );
  const gap = Number(setting?.value);
  if (!Number.isSafeInteger(gap) || gap < 0)
    throw new Error('Invalid social.action.min_gap_seconds');
  const runtime = account.settings.socialAction ?? {};
  const day = now.toISOString().slice(0, 10);
  const counts = runtime.day === day ? (runtime.counts ?? {}) : {};
  if (dailyLimit !== undefined && (counts[action] ?? 0) >= dailyLimit)
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
  const next = Date.parse(runtime.nextAt ?? '');
  if (next > now.getTime()) return new Date(next);
  await c.query(
    "update channel_accounts set settings=jsonb_set(settings,'{socialAction}',$2::jsonb) where id=$1",
    [
      accountId,
      JSON.stringify({
        day,
        counts: { ...counts, [action]: (counts[action] ?? 0) + 1 },
        nextAt: new Date(now.getTime() + gap * 1000).toISOString(),
      }),
    ],
  );
  return null;
}
