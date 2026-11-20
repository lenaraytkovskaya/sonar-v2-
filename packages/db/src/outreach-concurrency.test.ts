import { beforeEach, expect, it, vi } from 'vitest';
const { query, enqueue, log } = vi.hoisted(() => ({
  query: vi.fn(),
  enqueue: vi.fn(),
  log: vi.fn(),
}));
vi.mock('./index.js', () => ({ sonarPool: {} }));
vi.mock('./tasks.js', () => ({ enqueueTask: enqueue, logActivity: log }));
vi.mock('./email.js', () => ({
  EmailValidationError: class extends Error {},
  isContactBlocked: async () => false,
  transaction: (fn: (client: unknown) => unknown) => fn({ query }),
}));
import {
  editOutreachDraft,
  sendOutreachDraft,
  approveOutreachDraft,
  markOutreachManualSent,
} from './outreach';
const original = { subject: 'Subject', body: 'Original' };
let row: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  row = {
    ...original,
    id: 'message',
    conversation_id: 'conversation',
    company_id: 'company',
    status: 'draft',
    channel: 'email',
    source: 'reply',
    channels: { email: true },
    campaign_status: 'active',
    first_attempt_at: null,
  };
  query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes("where key='send.reply_duplicate_window_seconds'"))
      return { rows: [{ value: 120 }] };
    if (sql.startsWith('select body from messages where conversation_id='))
      return { rows: [] };
    if (sql.includes('as blocked')) return { rows: [{ blocked: false }] };
    if (sql.includes('for update of m')) return { rows: [{ ...row }] };
    if (sql.startsWith('select conversation_id,to_value'))
      return { rows: [{ conversation_id: 'conversation' }] };
    if (
      sql.startsWith('with recursive chain') ||
      sql.startsWith('select * from conversations')
    )
      return {
        rows: [
          {
            id: 'conversation',
            channel: row.channel,
            company_id: 'company',
            accounts: [],
          },
        ],
      };
    if (sql.startsWith('select company_id from conversations'))
      return { rows: [{ company_id: 'company' }] };
    if (sql.includes('select id from channel_accounts'))
      return { rows: [{ id: 'account' }] };
    if (sql.startsWith('update messages set subject'))
      Object.assign(row, { subject: values[1], body: values[2] });
    if (sql.startsWith('update messages set account_id')) row.status = 'queued';
    return { rows: [] };
  });
});
it('rejects stale saves and sends after locking the message, with no write or queue', async () => {
  row.body = 'Concurrent edit';
  await expect(
    editOutreachDraft(
      'message',
      { subject: 'Subject', body: 'Mine' },
      'actor',
      original,
    ),
  ).rejects.toThrow('Чернетку змінено');
  for (const send of [
    sendOutreachDraft,
    approveOutreachDraft,
    markOutreachManualSent,
  ]) {
    if (send === markOutreachManualSent) row.channel = 'social';
    await expect(send('message', 'actor', original)).rejects.toThrow(
      'Чернетку змінено',
    );
  }
  expect(
    query.mock.calls.some(([sql]) => sql.includes('for update of m')),
  ).toBe(true);
  expect(query.mock.calls.some(([sql]) => sql.startsWith('update '))).toBe(
    false,
  );
  expect(enqueue).not.toHaveBeenCalled();
});
it('makes a lost save response retryable, then blocks an intervening update before send', async () => {
  const mine = { subject: 'Subject', body: 'Mine' };
  await editOutreachDraft('message', mine, 'actor', original);
  await editOutreachDraft('message', mine, 'actor', original);
  expect(
    query.mock.calls.filter(([sql]) =>
      sql.startsWith('update messages set subject'),
    ),
  ).toHaveLength(1);
  row.body = 'Later edit';
  await expect(sendOutreachDraft('message', 'actor', mine)).rejects.toThrow(
    'Чернетку змінено',
  );
  expect(enqueue).not.toHaveBeenCalled();
});
it('queues the reviewed version once; repeating an accepted send does not enqueue again', async () => {
  await sendOutreachDraft('message', 'actor', original);
  await sendOutreachDraft('message', 'actor', original);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(
    'message.send',
    'message.send:message',
    { messageId: 'message' },
    expect.anything(),
  );
});
