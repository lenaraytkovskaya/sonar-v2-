import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'shares the campaign cap across classification and reply and bills unknown senders against the monthly cap',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runBudgetedRequest } = await import('./budget.js');
    const campaignId = randomUUID(),
      conversationId = randomUUID(),
      unknownId = randomUUID(),
      messageId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const {
      rows: [original],
    } = await sonarPool.query(
      "select value from settings where key='budget.monthly_usd'",
    );
    const paid = vi.fn(async () => ({
      id: 'stub',
      model: 'stub',
      text: 'result',
      units: 1,
      costUsd: 0.0006,
    }));
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','100') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Inbound budget','PL','pl','{}','{}','',0.001,'{}','{}')`,
        [campaignId],
      );
      await sonarPool.query(
        "insert into conversations(id,campaign_id,channel) values($1,$2,'email'),($3,null,'email')",
        [conversationId, campaignId, unknownId],
      );
      await sonarPool.query(
        "insert into messages(id,conversation_id,direction,to_value,subject,body,idempotency_key) values($1::uuid,$2,'in','test@example.invalid','Topic','Hello',$1::text)",
        [messageId, conversationId],
      );
      for (const [index, type, payload] of [
        [0, 'ai.inbound', { messageId }],
        [1, 'ai.reply', { conversationId }],
        [2, 'ai.reply', { conversationId: unknownId }],
        [3, 'ai.reply', { conversationId: unknownId }],
      ] as const)
        await sonarPool.query(
          'insert into tasks(id,type,idempotency_key,payload) values($1::uuid,$2,$1::text,$3)',
          [ids[index], type, payload],
        );
      await runBudgetedRequest('openrouter', 0.0006, ids[0]!, paid);
      await runBudgetedRequest('openrouter', 0.0006, ids[0]!, paid);
      expect(paid).toHaveBeenCalledTimes(1);
      await expect(
        runBudgetedRequest('openrouter', 0.0006, ids[1]!, paid),
      ).rejects.toMatchObject({ scope: 'campaign' });
      expect(paid).toHaveBeenCalledTimes(1);
      await runBudgetedRequest('openrouter', 0.0006, ids[2]!, paid);
      expect(paid).toHaveBeenCalledTimes(2);
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','0') on conflict(key) do update set value=excluded.value",
      );
      await expect(
        runBudgetedRequest('openrouter', 0.0006, ids[3]!, paid),
      ).rejects.toMatchObject({ scope: 'monthly' });
      expect(paid).toHaveBeenCalledTimes(2);
    } finally {
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from messages where id=$1', [messageId]);
      await sonarPool.query(
        'delete from conversations where id=any($1::uuid[])',
        [[conversationId, unknownId]],
      );
      await sonarPool.query('delete from campaigns where id=$1', [campaignId]);
      if (original)
        await sonarPool.query(
          "update settings set value=$1 where key='budget.monthly_usd'",
          [JSON.stringify(original.value)],
        );
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
