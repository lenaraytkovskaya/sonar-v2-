import type { PoolClient } from 'pg';
import { EmailValidationError } from './email.js';

/** Call while holding the conversation lock, after checking intent idempotency. */
export async function assertNoRecentReply(
  c: PoolClient,
  conversationId: string,
  body: string,
  messageId?: string,
) {
  const { rows: settings } = await c.query(
    "select value from settings where key='send.reply_duplicate_window_seconds'",
  );
  const seconds = settings[0]?.value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
    throw new EmailValidationError(
      'Налаштуйте період захисту від повторних повідомлень.',
    );
  const { rows } = await c.query(
    `select body from messages where conversation_id=$1 and direction='out'
      and (status in ('queued','sent','delivered','read') or (status='failed' and first_attempt_at is not null))
      and ($3::uuid is null or id<>$3)
      and coalesce(sent_at,first_attempt_at,approved_at,created_at)>clock_timestamp()-make_interval(secs=>$2)`,
    [conversationId, seconds, messageId ?? null],
  );
  const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
  if (rows.some((message) => normalized(message.body) === normalized(body)))
    throw new EmailValidationError('Таке саме повідомлення щойно надіслано');
}
