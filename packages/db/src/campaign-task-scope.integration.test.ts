import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('./tasks.js', async (original) => ({
  ...(await original<object>()),
  dispatch,
}));
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'isolates explicit task owners, shares enrichment once, and reads/resumes real campaigns without payload UUID casts',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { campaignTaskScope } = await import('./campaign-task-scope.js');
    const { campaignRunState, resumeCampaign } =
      await import('./campaign-run.js');
    const [
      a,
      b,
      company,
      batchA,
      batchB,
      conversationA,
      conversationB,
      message,
      user,
    ] = Array.from({ length: 9 }, () => randomUUID()) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const tasks: string[] = [];
    const add = async (
      type: string,
      payload: object,
      status = 'queued',
      batchId: string | null = null,
      subject = false,
    ) => {
      const id = randomUUID();
      tasks.push(id);
      await sonarPool.query(
        'insert into tasks(id,type,status,idempotency_key,batch_id,payload,subject_type,subject_id,reason_code,reason_uk) values($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8,$9)',
        [
          id,
          type,
          status,
          batchId,
          JSON.stringify(payload),
          subject ? 'company' : null,
          subject ? company : null,
          status === 'paused' ? 'campaign_paused' : null,
          'Fixture',
        ],
      );
      return id;
    };
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Scope test','stub')",
        [user, `${user}@example.invalid`],
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status) values($1,'A','UA','uk','{}','{}','',1,'{}','{}','paused'),($2,'B','UA','uk','{}','{}','',1,'{}','{}','active')",
        [a, b],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name) values($1::uuid,$1::text,'Shared')",
        [company],
      );
      await sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$3),($2,$3)',
        [a, b, company],
      );
      await sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$1),($3,$4,1,20,'{}',$3)",
        [batchA, a, batchB, b],
      );
      await sonarPool.query(
        'insert into conversations(id,company_id,campaign_id) values($1,$3,$4),($2,$3,$5)',
        [conversationA, conversationB, company, a, b],
      );
      await sonarPool.query(
        "insert into messages(id,conversation_id,to_value,subject,body,idempotency_key) values($1::uuid,$2,'test@example.invalid','','Fixture',$1::text)",
        [message, conversationA],
      );
      const realBatch = await add(
        'google.request',
        { campaignId: b, companyId: company },
        'queued',
        batchA,
      );
      const explicitA = await add('company.score', {
        campaignId: a,
        companyId: company,
      });
      const payloadBatch = await add(
        'google.batch',
        { batchId: batchB, companyId: company },
        'running',
      );
      const sendA = await add('message.send', { messageId: message }, 'paused');
      const conversationBTask = await add('ai.reply', {
        conversationId: conversationB,
      });
      const shared = await add('site.scan', { companyId: company });
      const heldShared = await add(
        'registry.match',
        { companyId: company },
        'paused',
      );
      const foreignHeld = await add(
        'registry.match',
        { campaignId: b, companyId: company },
        'paused',
      );
      const explicitB = await add(
        'site.scan',
        { campaignId: b, companyId: company },
        'failed',
      );
      const subjectShared = await add(
        'prozorro.company',
        {},
        'failed',
        null,
        true,
      );
      const malformed = await add('site.scan', {
        campaignId: 'not-a-uuid',
        batchId: 'bad',
        messageId: 'bad',
        conversationId: 'bad',
        companyId: company,
      });
      await add('message.send', { messageId: 'bad' });
      await add('ai.reply', { conversationId: 'bad' });
      await add('google.batch', { batchId: 'bad', companyId: company });
      await add('company.analyze', { companyId: company });
      for (const [id, cost] of [
        [realBatch, 0.125],
        [payloadBatch, 0.25],
        [malformed, 0.5],
      ])
        await sonarPool.query(
          "insert into spend_events(service_code,units,cost_usd,task_id) values('google_places',1,$1,$2)",
          [cost, id],
        );
      const ids = async (campaignId: string) =>
        (
          await sonarPool.query(
            `select t.id from tasks t where ${campaignTaskScope()}`,
            [campaignId],
          )
        ).rows
          .map((row) => row.id)
          .sort();
      expect(await ids(a)).toEqual(
        [realBatch, explicitA, sendA, shared, heldShared, subjectShared].sort(),
      );
      expect(await ids(b)).toEqual(
        [
          payloadBatch,
          conversationBTask,
          shared,
          heldShared,
          foreignHeld,
          explicitB,
          subjectShared,
        ].sort(),
      );
      expect(await campaignRunState(a)).toMatchObject({
        status: 'paused',
        active: 3,
        held: 2,
        spent: 0.125,
      });
      expect(await campaignRunState(b)).toMatchObject({
        active: 3,
        held: 2,
        spent: 0.25,
      });
      expect(await resumeCampaign(a, user)).toEqual({
        resumed: true,
        requeued: 2,
      });
      expect(dispatch.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining([sendA, heldShared]),
      );
      expect(
        (
          await sonarPool.query('select status from tasks where id=$1', [
            foreignHeld,
          ])
        ).rows[0].status,
      ).toBe('paused');
      expect(await resumeCampaign(a, user)).toEqual({
        resumed: false,
        requeued: 0,
      });
    } finally {
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [tasks],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        tasks,
      ]);
      await sonarPool.query('delete from messages where id=$1', [message]);
      await sonarPool.query(
        'delete from conversations where id=any($1::uuid[])',
        [[conversationA, conversationB]],
      );
      await sonarPool.query('delete from batches where id=any($1::uuid[])', [
        [batchA, batchB],
      ]);
      await sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [company],
      );
      await sonarPool.query('delete from companies where id=$1', [company]);
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [[a, b]],
      );
      await sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
        [a, b],
      ]);
      await sonarPool.query('delete from users where id=$1', [user]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    const { closeTaskQueue } = await import('./tasks.js');
    await closeTaskQueue();
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
