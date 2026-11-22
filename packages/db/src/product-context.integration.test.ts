import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { productOfferText } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'projects product knowledge into fresh analysis, draft and inbound snapshots without terms or stale legacy text',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { campaignOfferContext } = await import('./product-context.js');
    const { analysisSnapshot } = await import('./analysis.js');
    const { draftSnapshot } = await import('./outreach.js');
    const { getConversationHistory } = await import('./inbound.js');
    const productId = randomUUID(),
      campaignId = randomUUID(),
      companyId = randomUUID(),
      contactId = randomUUID(),
      conversationId = randomUUID(),
      analysisId = randomUUID();
    const taskIds = [randomUUID(), randomUUID()];
    try {
      const product = (
        await sonarPool.query(
          "insert into products(id,name,description,audience,benefits,terms,links,photos,status) values($1,'Product','Description','Audience','Benefit','SECRET_TERMS',$2,$3,'archived') returning *",
          [
            productId,
            JSON.stringify([
              { label: 'Site', url: 'https://example.invalid/public' },
            ]),
            JSON.stringify(['https://example.invalid/SECRET_PHOTO']),
          ],
        )
      ).rows[0];
      await sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,outreach_goal,budget_usd,channels,scoring_weights,product_id) values($1,'Context','UA','uk','{}','{}','LEGACY_OFFER','LEGACY_GOAL',1,'{\"email\":true}','{}',$2)",
        [campaignId, productId],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name) values($1::uuid,$1::text,'Recipient')",
        [companyId],
      );
      await sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$2)',
        [campaignId, companyId],
      );
      await sonarPool.query(
        "insert into company_scores(company_id,campaign_id,score,breakdown) values($1,$2,70,'{}')",
        [companyId, campaignId],
      );
      await sonarPool.query(
        "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,'email',$3,$3,'manual')",
        [contactId, companyId, `${companyId}@example.invalid`],
      );
      await sonarPool.query(
        "insert into analyses(id,company_id,campaign_id,version,model,cost_usd,result) values($1,$2,$3,'context','stub',0,$4)",
        [
          analysisId,
          companyId,
          campaignId,
          {
            summary: 'Recipient',
            language: 'uk',
            first_message: 'LEGACY_GENERATED',
          },
        ],
      );
      await sonarPool.query(
        'insert into conversations(id,company_id,campaign_id,contact_id) values($1,$2,$3,$4)',
        [conversationId, companyId, campaignId, contactId],
      );
      for (const [index, type] of ['company.analyze', 'ai.drafts'].entries())
        await sonarPool.query(
          'insert into tasks(id,type,idempotency_key) values($1::uuid,$2,$1::text)',
          [taskIds[index], type],
        );
      const draftInput = {
        companyId,
        campaignId,
        analysisId,
        contactId,
        version: 'context',
      };
      const analysis = await analysisSnapshot(
        companyId,
        campaignId,
        taskIds[0]!,
      );
      const draft = await draftSnapshot(draftInput, taskIds[1]!);
      const history = await getConversationHistory(conversationId);
      const offer = productOfferText(product);
      expect(analysis).toMatchObject({ offer, outreach_goal: '' });
      expect(draft).toMatchObject({ offer, outreachGoal: '' });
      expect(history.campaign).toMatchObject({ offer, outreachGoal: '' });
      for (const value of [analysis, draft, history.campaign])
        for (const secret of [
          'SECRET_TERMS',
          'SECRET_PHOTO',
          'LEGACY_OFFER',
          'LEGACY_GOAL',
          'LEGACY_GENERATED',
        ])
          expect(JSON.stringify(value)).not.toContain(secret);
      await sonarPool.query(
        'update campaigns set product_id=null where id=$1',
        [campaignId],
      );
      expect(await campaignOfferContext(campaignId)).toMatchObject({
        offer: 'LEGACY_OFFER',
        outreachGoal: 'LEGACY_GOAL',
      });
      expect(
        await analysisSnapshot(companyId, campaignId, taskIds[0]!),
      ).toMatchObject({ offer: 'LEGACY_OFFER', outreach_goal: 'LEGACY_GOAL' });
      expect(await draftSnapshot(draftInput, taskIds[1]!)).toMatchObject({
        offer: 'LEGACY_OFFER',
        outreachGoal: 'LEGACY_GOAL',
      });
      const frozen = {
        offer: 'Frozen paid offer',
        config: { 'ai.reasoning': {} },
      };
      await sonarPool.query('update tasks set result=$2 where id=$1', [
        taskIds[0],
        JSON.stringify({ analysisInput: frozen }),
      ]);
      await sonarPool.query(
        "insert into spend_events(service_code,units,cost_usd,task_id,meta) values('openrouter',1,0,$1,'{}')",
        [taskIds[0]],
      );
      await sonarPool.query('update tasks set result=$2 where id=$1', [
        taskIds[1],
        JSON.stringify({ draftInput: frozen, billingPending: true }),
      ]);
      await sonarPool.query('update campaigns set product_id=$2 where id=$1', [
        campaignId,
        productId,
      ]);
      expect(
        await analysisSnapshot(companyId, campaignId, taskIds[0]!),
      ).toEqual(frozen);
      expect(await draftSnapshot(draftInput, taskIds[1]!)).toEqual(frozen);
    } finally {
      await sonarPool.query(
        'delete from spend_events where task_id=any($1::uuid[])',
        [taskIds],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        taskIds,
      ]);
      await sonarPool.query('delete from conversations where id=$1', [
        conversationId,
      ]);
      await sonarPool.query('delete from contacts where id=$1', [contactId]);
      await sonarPool.query('delete from analyses where id=$1', [analysisId]);
      await sonarPool.query('delete from company_scores where company_id=$1', [
        companyId,
      ]);
      await sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [companyId],
      );
      await sonarPool.query('delete from companies where id=$1', [companyId]);
      await sonarPool.query('delete from campaigns where id=$1', [campaignId]);
      await sonarPool.query('delete from products where id=$1', [productId]);
    }
  },
);
it.skipIf(!enabled)(
  'appends idempotent policy suffixes without replacing custom prompts or paid-work versions',
  async () => {
    const { sonarPool } = await import('./index.js');
    const client = await sonarPool.connect();
    try {
      await client.query('begin');
      await client.query(
        'create temp table settings(key text,value jsonb,updated_at timestamptz) on commit drop',
      );
      await client.query(
        "insert into settings values('analysis.prompt','\"Custom analysis\"',now()),('draft.prompt','\"Custom draft\"',now()),('analysis.version','\"42\"',now()),('draft.version','\"18\"',now()),('ai.actions',$1,now())",
        [
          JSON.stringify({
            inbound: 'Custom classifier',
            reply: 'Custom reply',
            custom: 'Keep rewrite',
            campaign: 'Keep niche',
          }),
        ],
      );
      const sql = readFileSync(
        new URL(
          '../drizzle/0079_product_knowledge_prompts.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await client.query(sql);
      const rows = (
        await client.query('select key,value from settings order by key')
      ).rows;
      const config = Object.fromEntries(
        rows.map((row) => [row.key, row.value]),
      );
      expect(config['analysis.prompt']).toContain(
        'Custom analysis\n[product-knowledge-v1]',
      );
      expect(config['draft.prompt']).toContain(
        'Custom draft\n[product-knowledge-v1]',
      );
      expect(config['ai.actions']).toMatchObject({
        custom: 'Keep rewrite',
        campaign: 'Keep niche',
      });
      expect(config['ai.actions'].inbound).toContain(
        'Custom classifier\n[product-knowledge-v1]',
      );
      expect(config['ai.actions'].reply).toContain(
        'Custom reply\n[product-knowledge-v1]',
      );
      expect([config['analysis.version'], config['draft.version']]).toEqual([
        '42',
        '18',
      ]);
      await client.query(sql);
      expect(
        (await client.query('select key,value from settings order by key'))
          .rows,
      ).toEqual(rows);
    } finally {
      await client.query('rollback');
      client.release();
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
