import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'opens one dialog per contact and records a hand-written first message',
  async () => {
    const db = await import('./index.js');
    const inbound = await import('./inbound.js');
    const [company, campaign, account, email, form] = Array.from(
      { length: 5 },
      () => randomUUID(),
    );
    try {
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,'manual:'||$1::text,'Dialog test','UA')",
        [company],
      );
      await db.sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status) values($1,'Dialog test','UA','uk','{}','{}','',0,'{}','{}','active')",
        [campaign],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$2)',
        [campaign, company],
      );
      await db.sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,status,daily_limit) values($1,'email','Dialog','dialog@example.invalid','active',10)",
        [account],
      );
      await db.sonarPool.query(
        "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$3,'email','hello@example.invalid','hello@example.invalid','manual'),($2,$3,'form','https://example.invalid/contact','https://example.invalid/contact','manual')",
        [email, form, company],
      );
      const first = await inbound.ensureContactConversation(email);
      expect(await inbound.ensureContactConversation(email)).toBe(first);
      const sent = await inbound.queueConversationReply(
        {
          conversationId: first,
          subject: 'Hello',
          body: 'Written by hand',
          requestId: randomUUID(),
        },
        null as unknown as string,
      );
      expect(sent.status).toBe('queued');
      const {
        rows: [message],
      } = await db.sonarPool.query(
        'select to_value,account_id,source from messages where id=$1',
        [sent.id],
      );
      expect(message).toMatchObject({
        to_value: 'hello@example.invalid',
        account_id: account,
        source: 'reply',
      });
      const manual = await inbound.ensureContactConversation(form);
      const marked = await inbound.queueConversationReply(
        { conversationId: manual, body: 'Form text', requestId: randomUUID() },
        null as unknown as string,
      );
      expect(marked.status).toBe('sent');
    } finally {
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in (select id::text from messages where conversation_id in (select id from conversations where company_id=$1))",
        [company],
      );
      await db.sonarPool.query(
        'delete from messages where conversation_id in (select id from conversations where company_id=$1)',
        [company],
      );
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [company],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        company,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [company],
      );
      await db.sonarPool.query('delete from campaigns where id=$1', [campaign]);
      await db.sonarPool.query('delete from companies where id=$1', [company]);
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        account,
      ]);
    }
  },
);
afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('./tasks.js');
  await closeTaskQueue();
  const db = await import('./index.js');
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
