import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let outreach: typeof import('./outreach.js');
let tasks: typeof import('./tasks.js');
let admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  outreach = await import('./outreach.js');
  tasks = await import('./tasks.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('ai.drafts');
  await admin.createQueue('message.send');
});

it.skipIf(!enabled)(
  'keeps one first draft per contact, isolates chats, enforces approval and score gates, and records manual outreach without sending',
  async () => {
    const userId = randomUUID(),
      companyId = randomUUID(),
      campaignId = randomUUID(),
      batchId = randomUUID(),
      accountId = randomUUID();
    const contacts: Record<string, string> = {};
    try {
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Outreach test','stub')",
        [userId, `${userId}@example.invalid`],
      );
      await db.sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,outreach_goal,budget_usd,channels,scoring_weights,min_score,send_mode,status) values($1,'Outreach test','PL','pl','{}','{}','Test offer','Arrange a call',1,'{"email":true,"forms":true}','{}',40,'approval','active')`,
        [campaignId],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [batchId, campaignId, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,domain,website,country_code) values($1,$2,'Outreach test','ready','example.invalid','https://example.invalid','PL')",
        [companyId, companyId],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(company_id,campaign_id,batch_id) values($1,$2,$3)',
        [companyId, campaignId, batchId],
      );
      await db.sonarPool.query(
        "insert into company_scores(company_id,campaign_id,score,breakdown) values($1,$2,70,'{}')",
        [companyId, campaignId],
      );
      for (const [kind, value, rank] of [
        ['email', 'first@example.invalid', 100],
        ['email', 'second@example.invalid', 90],
        ['form', 'https://example.invalid/contact', 80],
        ['social', 'https://linkedin.com/company/test', 70],
        ['phone', '+48123456789', 60],
      ] as const) {
        const {
          rows: [contact],
        } = await db.sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source,rank) values($1,$2,$3,$3,'manual',$4) returning id",
          [companyId, kind, value, rank],
        );
        contacts[value] = contact.id;
      }
      await db.sonarPool.query(
        "insert into channel_accounts(id,name,address,daily_limit,owner_id) values($1,'Outreach test','from@example.invalid',100,$2)",
        [accountId, userId],
      );
      const {
        rows: [analysis],
      } = await db.sonarPool.query(
        "insert into analyses(company_id,campaign_id,version,model,cost_usd,result) values($1,$2,'outreach-test','stub',0,$3) returning id",
        [
          companyId,
          campaignId,
          {
            language: 'pl',
            description: 'Test company',
            first_message: 'Old generic message',
          },
        ],
      );
      const first = await outreach.enqueueOutreachDrafts(
        companyId,
        campaignId,
        analysis.id,
      );
      expect(first).toHaveLength(3);
      expect(
        (
          await outreach.enqueueOutreachDrafts(
            companyId,
            campaignId,
            analysis.id,
          )
        ).map((t) => t.id),
      ).toEqual(first.map((t) => t.id));
      const manual = await outreach.enqueueDraft(
        {
          companyId,
          campaignId,
          contactId: contacts['first@example.invalid']!,
          requestId: randomUUID(),
        },
        userId,
      );
      const repeated = await outreach.enqueueDraft(
        {
          companyId,
          campaignId,
          contactId: contacts['first@example.invalid']!,
          requestId: randomUUID(),
        },
        userId,
      );
      expect(repeated.id).toBe(manual.id);
      const { rows: jobs } = await db.sonarPool.query(
        "select id,payload from tasks where type='ai.drafts' and payload->>'companyId'=$1 order by payload->>'contactId'",
        [companyId],
      );
      const emailJob = jobs.find(
        (job) => job.payload.contactId === contacts['first@example.invalid'],
      );
      const secondJob = jobs.find(
        (job) => job.payload.contactId === contacts['second@example.invalid'],
      );
      const formJob = jobs.find(
        (job) =>
          job.payload.contactId === contacts['https://example.invalid/contact'],
      );
      const draft = {
        subject: 'Personal offer',
        body: 'A personal message in Polish',
      };
      const saved = await Promise.all([
        outreach.saveOutreachDraft(emailJob.payload, draft, emailJob.id),
        outreach.saveOutreachDraft(emailJob.payload, draft, emailJob.id),
      ]);
      expect(saved[0]).toEqual(saved[1]);
      expect(saved[0]?.status).toBe('draft');
      const second = await outreach.saveOutreachDraft(
        secondJob.payload,
        draft,
        secondJob.id,
      );
      const form = await outreach.saveOutreachDraft(
        formJob.payload,
        { subject: '', body: 'Form message' },
        formJob.id,
      );
      let chat = await outreach.getCompanyChat(companyId);
      expect(
        chat.conversations.filter((c) => c.channel === 'email'),
      ).toHaveLength(2);
      expect(chat.messages).toHaveLength(3);
      await outreach.editOutreachDraft(
        saved[0]!.id,
        { subject: 'Edited', body: 'Reviewed by a person' },
        userId,
      );
      expect(
        (await outreach.sendOutreachDraft(saved[0]!.id, userId)).status,
      ).toBe('awaiting_approval');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='message.send' and payload->>'messageId'=$1",
            [saved[0]!.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await outreach.approveOutreachDraft(saved[0]!.id, userId)).status,
      ).toBe('queued');
      expect(
        (await outreach.approveOutreachDraft(saved[0]!.id, userId)).status,
      ).toBe('queued');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='message.send' and payload->>'messageId'=$1",
            [saved[0]!.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await outreach.markOutreachManualSent(form.id, userId)).status,
      ).toBe('sent');
      await outreach.markOutreachManualSent(form.id, userId);
      expect(
        (
          await db.sonarPool.query(
            'select source,direction,sent_at from messages where id=$1',
            [form.id],
          )
        ).rows[0],
      ).toMatchObject({
        source: 'manual',
        direction: 'out',
        sent_at: expect.any(Date),
      });
      expect(
        (await outreach.skipOutreachMessage(second.id, userId)).status,
      ).toBe('skipped');
      await db.sonarPool.query(
        "update campaigns set send_mode='auto' where id=$1",
        [campaignId],
      );
      const {
        rows: [autoContact],
      } = await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source,rank) values($1,'email','auto@example.invalid','auto@example.invalid','manual',10) returning id",
        [companyId],
      );
      const autoTask = await outreach.enqueueDraft(
        {
          companyId,
          campaignId,
          contactId: autoContact.id,
          requestId: randomUUID(),
        },
        userId,
      );
      const autoInput = (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          autoTask.id,
        ])
      ).rows[0].payload;
      const autoMessage = await outreach.saveOutreachDraft(
        autoInput,
        draft,
        autoTask.id,
      );
      expect(autoMessage.status).toBe('queued');
      await db.sonarPool.query(
        'update campaigns set min_score=90 where id=$1',
        [campaignId],
      );
      const { sendEmailMessage } = await import('./email.js');
      const sender = vi.fn(async () => 'stub-provider');
      expect(
        await sendEmailMessage(autoMessage.id, randomUUID(), sender),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'score_below_threshold',
      });
      expect(sender).not.toHaveBeenCalled();
      await db.sonarPool.query(
        'update campaigns set min_score=40 where id=$1',
        [campaignId],
      );
      const callInput = {
        companyId,
        campaignId,
        contactId: contacts['+48123456789']!,
        body: 'Reached the owner; call next week.',
        requestId: randomUUID(),
      };
      const call = await outreach.logOutreachCall(callInput, userId);
      expect(await outreach.logOutreachCall(callInput, userId)).toEqual(call);
      expect(
        (
          await db.sonarPool.query(
            'select channel,source,direction,status from messages where id=$1',
            [call.id],
          )
        ).rows[0],
      ).toEqual({
        channel: 'call',
        source: 'manual',
        direction: 'out',
        status: 'sent',
      });
      expect(
        (
          await outreach.getInbox({
            campaignId,
            channel: 'email',
            status: 'queued',
          })
        ).conversations,
      ).toHaveLength(2);

      await db.sonarPool.query(
        "update campaigns set send_mode='manual' where id=$1",
        [campaignId],
      );
      const {
        rows: [manualContact],
      } = await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source,rank) values($1,'email','manual@example.invalid','manual@example.invalid','manual',5) returning id",
        [companyId],
      );
      const manualTask = await outreach.enqueueDraft(
        {
          companyId,
          campaignId,
          contactId: manualContact.id,
          requestId: randomUUID(),
        },
        userId,
      );
      const manualInput = (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          manualTask.id,
        ])
      ).rows[0].payload;
      const manualMessage = await outreach.saveOutreachDraft(
        manualInput,
        draft,
        manualTask.id,
      );
      expect(manualMessage.status).toBe('draft');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='message.send' and payload->>'messageId'=$1",
            [manualMessage.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await outreach.sendOutreachDraft(manualMessage.id, userId)).status,
      ).toBe('queued');
      expect(
        (await outreach.sendOutreachDraft(manualMessage.id, userId)).status,
      ).toBe('queued');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='message.send' and payload->>'messageId'=$1",
            [manualMessage.id],
          )
        ).rows[0].n,
      ).toBe(1);
      await db.sonarPool.query(
        "update campaigns set send_mode='auto' where id=$1",
        [campaignId],
      );

      await db.sonarPool.query(
        'update campaigns set min_score=90 where id=$1',
        [campaignId],
      );
      expect(
        await outreach.enqueueOutreachDrafts(
          companyId,
          campaignId,
          analysis.id,
        ),
      ).toEqual([]);
      expect(
        await outreach.draftSnapshot(secondJob.payload, secondJob.id),
      ).toBeNull();
      await expect(
        outreach.enqueueDraft(
          {
            companyId,
            campaignId,
            contactId: contacts['https://linkedin.com/company/test']!,
            requestId: randomUUID(),
          },
          userId,
        ),
      ).rejects.toThrow('поріг');
      await db.sonarPool.query(
        'update campaigns set min_score=40 where id=$1',
        [campaignId],
      );
      const socialTask = await outreach.enqueueDraft(
        {
          companyId,
          campaignId,
          contactId: contacts['https://linkedin.com/company/test']!,
          requestId: randomUUID(),
        },
        userId,
      );
      const socialInput = (
        await db.sonarPool.query('select payload from tasks where id=$1', [
          socialTask.id,
        ])
      ).rows[0].payload;
      const social = await outreach.saveOutreachDraft(
        socialInput,
        { subject: '', body: 'Manual social draft' },
        socialTask.id,
      );
      expect(social.status).toBe('draft');
      expect(
        (await outreach.markOutreachManualSent(social.id, userId)).status,
      ).toBe('sent');
      expect(
        (
          await db.sonarPool.query(
            'select channel,source,direction,status,sent_at from messages where id=$1',
            [social.id],
          )
        ).rows[0],
      ).toEqual({
        channel: 'social',
        source: 'manual',
        direction: 'out',
        status: 'sent',
        sent_at: expect.any(Date),
      });
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int as n from tasks where type='message.send' and payload->>'messageId'=$1",
            [social.id],
          )
        ).rows[0].n,
      ).toBe(0);
      await db.sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason) values('email','first@example.invalid',$1)",
        [companyId],
      );
      chat = await outreach.getCompanyChat(companyId);
      expect(chat.blocked).toBe(false);
      expect(chat.blockedContactIds).toContain(
        contacts['first@example.invalid'],
      );
      expect(chat.blockedContactIds).not.toContain(
        contacts['https://linkedin.com/company/test'],
      );
      await expect(
        outreach.sendOutreachDraft(saved[0]!.id, userId),
      ).rejects.toThrow('Не контактувати');
      await db.sonarPool.query(
        "insert into do_not_contact(company_id,kind,value_normalized,reason) values($1::uuid,'company',$1::text,'Test refusal')",
        [companyId],
      );
      await expect(
        outreach.editOutreachDraft(social.id, { body: 'Changed' }, userId),
      ).rejects.toThrow('Не контактувати');
      await expect(
        outreach.markOutreachManualSent(social.id, userId),
      ).rejects.toThrow('Не контактувати');
      await expect(
        outreach.logOutreachCall(
          { ...callInput, requestId: randomUUID() },
          userId,
        ),
      ).rejects.toThrow('Не контактувати');
      const { runBudgetedRequest } = await import('./budget.js');
      const operation = vi.fn();
      await db.sonarPool.query(
        'update campaigns set budget_usd=0.0001 where id=$1',
        [campaignId],
      );
      const {
        rows: [budget],
      } = await db.sonarPool.query(
        "select value from settings where key='budget.monthly_usd'",
      );
      const {
        rows: [service],
      } = await db.sonarPool.query(
        "select monthly_limit_usd from services where code='openrouter'",
      );
      try {
        await db.sonarPool.query(
          "update settings set value='1000000' where key='budget.monthly_usd'",
        );
        await db.sonarPool.query(
          "update services set monthly_limit_usd=null where code='openrouter'",
        );
        await expect(
          runBudgetedRequest('openrouter', 0.001, socialTask.id, operation),
        ).rejects.toMatchObject({ scope: 'campaign' });
      } finally {
        await db.sonarPool.query(
          "update settings set value=$1 where key='budget.monthly_usd'",
          [JSON.stringify(budget.value)],
        );
        await db.sonarPool.query(
          "update services set monthly_limit_usd=$1 where code='openrouter'",
          [service.monthly_limit_usd],
        );
      }
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await db.sonarPool.query(
        "delete from spend_events where task_id in(select id from tasks where payload->>'companyId'=$1 or payload->>'messageId' in(select m.id::text from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1::uuid))",
        [companyId],
      );
      await db.sonarPool.query(
        "delete from tasks where payload->>'companyId'=$1 or payload->>'messageId' in(select m.id::text from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1::uuid)",
        [companyId],
      );
      await db.sonarPool.query(
        'delete from messages where conversation_id in(select id from conversations where company_id=$1)',
        [companyId],
      );
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [companyId],
      );
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1 or reason=$1::text',
        [companyId],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        companyId,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [companyId],
      );
      await db.sonarPool.query('delete from companies where id=$1', [
        companyId,
      ]);
      await db.sonarPool.query('delete from batches where id=$1', [batchId]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        campaignId,
      ]);
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        accountId,
      ]);
      await db.sonarPool.query(
        'delete from activity_log where entity_id=$1 or user_id=$2',
        [companyId, userId],
      );
      await db.sonarPool.query('delete from users where id=$1', [userId]);
    }
  },
  30000,
);

afterAll(async () => {
  if (!enabled) return;
  await admin.stop({ graceful: true });
  await tasks.closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
