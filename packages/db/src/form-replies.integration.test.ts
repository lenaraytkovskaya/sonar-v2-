import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'matches form replies with reversible human choices, scoped candidates and idempotent stub billing',
  async () => {
    const { sonarPool } = await import('@sonar/db');
    const replies = await import('@sonar/db/form-replies');
    const { matchFormReply } =
      await import('../../../apps/worker/src/form-replies.js');
    const company = randomUUID(),
      otherCompany = randomUUID(),
      campaign = randomUUID(),
      formConversation = randomUUID(),
      otherFormConversation = randomUUID();
    const form = randomUUID(),
      otherForm = randomUUID();
    const socialConversation = randomUUID(),
      socialReplyConversation = randomUUID();
    const socialOutreach = randomUUID(),
      socialReply = randomUUID(),
      socialTask = randomUUID();
    const conversations = [randomUUID(), randomUUID(), randomUUID()];
    const messages = conversations.map(() => randomUUID()),
      tasks = conversations.map(() => randomUUID());
    const keys = [
      'ai.models',
      'ai.model.cheap',
      'budget.monthly_usd',
      'forms.match_auto_threshold',
    ];
    const original = (
      await sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    const set = (key: string, value: unknown) =>
      sonarPool.query(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
        [key, JSON.stringify(value)],
      );
    const complete = vi.fn(async () => ({
      id: 'stub',
      model: 'stub',
      text: JSON.stringify({
        companyId: company,
        confidence: 0.6,
        reasonUk: 'Назва може збігатися.',
      }),
      units: 10,
      costUsd: 0.001,
    }));
    const client = { complete, models: vi.fn() };
    try {
      vi.stubEnv('OPENROUTER_API_KEY', '');
      await set('budget.monthly_usd', 100);
      await set('ai.models', [
        {
          id: 'stub',
          name: 'Stub',
          promptUsd: 0,
          completionUsd: 0,
          requestUsd: 0,
        },
      ]);
      await set('ai.model.cheap', 'stub');
      await set('forms.match_auto_threshold', 0.8);
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code,website) values($1::uuid,'manual:'||$1::text,'Reply candidate','PL','https://company.invalid'),($2::uuid,'manual:'||$2::text,'Other candidate','PL','https://other.invalid')",
        [company, otherCompany],
      );
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) values($1,'Reply match test','PL','pl','{}','{}','',10,'{}','{}')",
        [campaign],
      );
      await sonarPool.query(
        "insert into conversations(id,company_id,campaign_id,channel) values($1,$2,$3,'form'),($4,$5,$3,'form')",
        [
          formConversation,
          company,
          campaign,
          otherFormConversation,
          otherCompany,
        ],
      );
      await sonarPool.query(
        "insert into messages(id,conversation_id,channel,to_value,subject,body,status,idempotency_key,sent_at,request_snapshot) values($1::uuid,$2,'form','https://company.invalid/form','','draft text','sent',$1::text,now(),'{\"sharedContacts\":[\"email\"],\"body\":\"Actual sent body and contact email\"}'),($3::uuid,$4,'form','https://other.invalid/form','','Other message','sent',$3::text,now(),'{\"sharedContacts\":[\"telegram\"]}')",
        [form, formConversation, otherForm, otherFormConversation],
      );
      await sonarPool.query(
        "insert into conversations(id,company_id,campaign_id,channel) values($1,$2,$3,'social'),($4,null,null,'social')",
        [socialConversation, company, campaign, socialReplyConversation],
      );
      await sonarPool.query(
        "insert into messages(id,conversation_id,channel,direction,to_value,subject,body,status,idempotency_key,sent_at) values($1::uuid,$2,'social','out','https://instagram.com/company/','','Social outreach','sent',$1::text,now()),($3::uuid,$4,'social','in','https://instagram.com/peer/','','Could this fit?','delivered',$3::text,now())",
        [
          socialOutreach,
          socialConversation,
          socialReply,
          socialReplyConversation,
        ],
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,payload) values($1::uuid,'form.reply.match',$1::text,$2)",
        [
          socialTask,
          { conversationId: socialReplyConversation, messageId: socialReply },
        ],
      );
      for (let i = 0; i < conversations.length; i++) {
        await sonarPool.query(
          "insert into conversations(id,channel) values($1,'email')",
          [conversations[i]],
        );
        await sonarPool.query(
          "insert into messages(id,conversation_id,direction,to_value,subject,body,idempotency_key) values($1::uuid,$2,'in','response@unmatched.invalid','','Відповідає Reply candidate',$1::text)",
          [messages[i], conversations[i]],
        );
        await sonarPool.query(
          "insert into tasks(id,type,idempotency_key,payload) values($1::uuid,'form.reply.match',$1::text,$2)",
          [
            tasks[i],
            { conversationId: conversations[i], messageId: messages[i] },
          ],
        );
      }
      const candidates = await replies.getFormReplyCandidates(
        'email',
        30,
        100,
        1500,
      );
      expect(candidates.find((c) => c.companyId === company)).toMatchObject({
        formMessageId: form,
        message: 'Actual sent body and contact email',
      });
      expect(candidates.some((c) => c.companyId === otherCompany)).toBe(false);
      const socialCandidates = await replies.getFormReplyCandidates(
        'social',
        365,
        100,
        1500,
      );
      expect(
        socialCandidates.find((c) => c.companyId === company),
      ).toMatchObject({
        formMessageId: socialOutreach,
        message: 'Social outreach',
      });
      expect(
        await matchFormReply(
          { conversationId: socialReplyConversation, messageId: socialReply },
          socialTask,
          client,
        ),
      ).toMatchObject({ result: { bound: false, applied: true } });
      expect(
        await replies.getFormReplyMatch(socialReplyConversation),
      ).toMatchObject({
        state: 'suggested',
        method: 'ai',
        suggestedCompanyId: company,
        formMessageId: socialOutreach,
      });
      expect(complete).toHaveBeenCalledOnce();
      complete.mockClear();
      expect(
        await matchFormReply(
          { conversationId: conversations[0]!, messageId: messages[0]! },
          tasks[0]!,
        ),
      ).toMatchObject({ reasonCode: 'reply_match_key_missing' });
      expect(complete).not.toHaveBeenCalled();
      await matchFormReply(
        { conversationId: conversations[0]!, messageId: messages[0]! },
        tasks[0]!,
        client,
      );
      await matchFormReply(
        { conversationId: conversations[0]!, messageId: messages[0]! },
        tasks[0]!,
        client,
      );
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await replies.getFormReplyMatch(conversations[0]!)).toMatchObject({
        state: 'suggested',
        suggestedCompanyId: company,
        suggestedCompanyName: 'Reply candidate',
        formMessageId: form,
      });
      expect(
        Number(
          (
            await sonarPool.query(
              'select count(*) n from spend_events where task_id=$1',
              [tasks[0]],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
      expect(
        await replies.rejectFormReplySuggestion(conversations[0]!, null),
      ).toBe(true);
      expect(
        await matchFormReply(
          { conversationId: conversations[0]!, messageId: messages[0]! },
          tasks[0]!,
          client,
        ),
      ).toMatchObject({ reasonCode: 'reply_match_resolved' });
      expect(
        await replies.bindFormReplyConversation({
          conversationId: conversations[0]!,
          companyId: company,
        }),
      ).toBe(true);
      expect(
        await replies.bindFormReplyConversation({
          conversationId: conversations[0]!,
          companyId: company,
        }),
      ).toBe(true);
      expect(
        Number(
          (
            await sonarPool.query(
              "select count(*) n from activity_log where entity_id=$1 and action='form.reply.bound'",
              [conversations[0]],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
      expect(
        await replies.unbindFormReplyConversation(conversations[0]!, null),
      ).toBe(true);
      expect(
        await replies.unbindFormReplyConversation(conversations[0]!, null),
      ).toBe(false);
      expect(
        (
          await sonarPool.query(
            'select company_id,campaign_id,contact_id from conversations where id=$1',
            [conversations[0]],
          )
        ).rows[0],
      ).toEqual({ company_id: null, campaign_id: null, contact_id: null });
      expect(
        await replies.bindFormReplyConversation({
          conversationId: conversations[0]!,
          companyId: company,
        }),
      ).toBe(true);
      expect(
        await replies.unbindFormReplyConversation(conversations[0]!, null),
      ).toBe(true);
      expect(
        (
          await sonarPool.query(
            'select campaign_id from conversations where id=$1',
            [conversations[0]],
          )
        ).rows[0].campaign_id,
      ).toBeNull();
      complete.mockResolvedValueOnce({
        id: 'stub',
        model: 'stub',
        text: JSON.stringify({
          companyId: company,
          confidence: 0.9,
          reasonUk: 'Назва та зміст збігаються.',
        }),
        units: 10,
        costUsd: 0.001,
      });
      expect(
        await matchFormReply(
          { conversationId: conversations[1]!, messageId: messages[1]! },
          tasks[1]!,
          client,
        ),
      ).toMatchObject({ status: 'done', result: { bound: true } });
      expect(await replies.getFormReplyMatch(conversations[1]!)).toMatchObject({
        state: 'bound',
        companyId: company,
        method: 'ai',
        formMessageId: form,
      });
      complete.mockImplementationOnce(async () => {
        await replies.bindFormReplyConversation({
          conversationId: conversations[2]!,
          companyId: otherCompany,
        });
        return {
          id: 'stub',
          model: 'stub',
          text: JSON.stringify({
            companyId: company,
            confidence: 0.95,
            reasonUk: 'Збіг назви.',
          }),
          units: 10,
          costUsd: 0.001,
        };
      });
      expect(
        await matchFormReply(
          { conversationId: conversations[2]!, messageId: messages[2]! },
          tasks[2]!,
          client,
        ),
      ).toMatchObject({ result: { bound: false, applied: false } });
      expect(await replies.getFormReplyMatch(conversations[2]!)).toMatchObject({
        state: 'bound',
        companyId: otherCompany,
        method: 'manual',
      });
    } finally {
      vi.unstubAllEnvs();
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [[...tasks, socialTask]],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        [...tasks, socialTask],
      ]);
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [[...conversations, company, otherCompany]],
      );
      await sonarPool.query(
        'delete from messages where conversation_id=any($1::uuid[])',
        [
          [
            ...conversations,
            formConversation,
            otherFormConversation,
            socialConversation,
            socialReplyConversation,
          ],
        ],
      );
      await sonarPool.query(
        'delete from conversations where id=any($1::uuid[])',
        [
          [
            ...conversations,
            formConversation,
            otherFormConversation,
            socialConversation,
            socialReplyConversation,
          ],
        ],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        [company, otherCompany],
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaign]);
      await sonarPool.query('delete from settings where key=any($1::text[])', [
        keys,
      ]);
      for (const row of original) await set(row.key, row.value);
    }
  },
);
afterAll(async () => {
  if (!enabled) return;
  const db = await import('@sonar/db');
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
