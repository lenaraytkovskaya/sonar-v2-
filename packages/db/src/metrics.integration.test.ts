import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'reports UTC actual spend, reservations, attribution, cohort and independent channel/task windows',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { financeMetrics, overviewMetrics } = await import('./metrics.js');
    const baseline = await overviewMetrics();
    const client = await sonarPool.connect();
    const campaign = randomUUID(),
      otherCampaign = randomUUID(),
      batch = randomUUID();
    const companies = Array.from({ length: 8 }, () => randomUUID());
    const service = `metrics-${randomUUID()}`,
      unlimited = `metrics-${randomUUID()}`;
    const account = randomUUID(),
      conversation = randomUUID(),
      message = randomUUID();
    const tasks = Array.from({ length: 8 }, () => randomUUID());
    try {
      await client.query(
        "insert into services(code,name,monthly_limit_usd) values($1,'Metrics',30),($2,'Unlimited',null)",
        [service, unlimited],
      );
      await client.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights) select id,'Metrics','UA','uk','{}','{}','test',100,'{}','{}' from unnest($1::uuid[]) id",
        [[campaign, otherCampaign]],
      );
      await client.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [batch, campaign, randomUUID()],
      );
      for (let i = 0; i < companies.length; i++) {
        await client.query(
          "insert into companies(id,place_id,name,status,created_at) values($1::uuid,$1::text,'Metrics',$2,$3)",
          [
            companies[i],
            [
              'new',
              'ready',
              'deal',
              'refused',
              'do_not_contact',
              'new',
              'deal',
              'new',
            ][i],
            i >= 6 ? '2001-01-01T00:00:00Z' : new Date(),
          ],
        );
        // One old company was linked long ago; another joins the campaign now.
        await client.query(
          'insert into campaign_companies(campaign_id,company_id,added_at) values($1,$2,$3)',
          [
            i === 5 ? otherCampaign : campaign,
            companies[i],
            i === 6 ? '2001-01-01T00:00Z' : new Date(),
          ],
        );
      }
      // A company in two campaigns counts once globally.
      await client.query(
        'insert into campaign_companies(campaign_id,company_id) values($1,$2)',
        [otherCampaign, companies[2]],
      );
      await client.query(
        "insert into contacts(company_id,kind,value,normalized,source,found_at) values($1,'email','a@example.invalid','a@example.invalid','website','2001-01-01T00:00Z'),($2,'email','b@example.invalid','b@example.invalid','website','2001-01-31T23:59:59Z')",
        [companies[0], companies[6]],
      );
      await client.query(
        "insert into channel_accounts(id,name,address,daily_limit) values($1,'Metrics','metrics@example.invalid',100)",
        [account],
      );
      await client.query(
        'insert into conversations(id,company_id,campaign_id) values($1,$2,$3)',
        [conversation, companies[3], campaign],
      );
      await client.query(
        "insert into messages(id,conversation_id,account_id,to_value,subject,body,status,sent_at,idempotency_key) values($1::uuid,$2,$3,'test@example.invalid','test','test','sent',now(),$1::text)",
        [message, conversation, account],
      );
      await client.query(
        "insert into messages(conversation_id,account_id,to_value,subject,body,status,direction,idempotency_key) values($1,$2,'test@example.invalid','test','test','delivered','in',$3)",
        [conversation, account, randomUUID()],
      );
      for (let i = 0; i < tasks.length; i++) {
        await client.query(
          "insert into tasks(id,type,idempotency_key,batch_id,payload,status,finished_at,subject_type,subject_id,result) values($1::uuid,'metrics.test',$1::text,$2,$3,$4,$5,$6,$7,$8)",
          [
            tasks[i],
            i === 0 ? batch : null,
            i === 1
              ? { campaignId: campaign }
              : i === 2
                ? { messageId: message }
                : {},
            i >= 5 ? 'failed' : 'done',
            i === 7 ? new Date(Date.now() - 25 * 3600000) : new Date(),
            i >= 5 ? 'company' : null,
            i >= 5 ? companies[i === 6 ? 6 : 0] : null,
            i === 4
              ? {
                  billingPending: true,
                  billingService: service,
                  billingEstimate: 5,
                  billingAt: '2001-01-15T00:00Z',
                }
              : {},
          ],
        );
      }
      for (let i = 0; i < 4; i++)
        await client.query(
          'insert into spend_events(service_code,units,cost_usd,task_id,created_at) values($1,1,$2,$3,$4)',
          [
            i === 3 ? unlimited : service,
            i + 1,
            tasks[i],
            i === 0 ? '2001-01-01T00:00:00Z' : '2001-01-31T23:59:59Z',
          ],
        );
      // Neighbouring months must not leak into the UTC month.
      await client.query(
        "insert into spend_events(service_code,units,cost_usd,created_at) values($1,1,99,'2000-12-31T23:59:59Z'),($1,1,99,'2001-02-01T00:00:00Z')",
        [service],
      );

      const finance = await financeMetrics('2001-01');
      expect(finance).toMatchObject({
        totalUsd: 10,
        reservedUsd: 5,
        companyCount: 2,
        contactCount: 2,
        costPerCompanyUsd: 5,
        costPerContactUsd: 5,
      });
      expect(finance.remainingUsd).toBe(
        Math.max(0, finance.monthlyLimitUsd - 15),
      );
      expect(finance.services.find((s) => s.code === service)).toMatchObject({
        spentUsd: 6,
        reservedUsd: 5,
        limitUsd: 30,
        remainingUsd: 19,
      });
      expect(finance.services.find((s) => s.code === unlimited)).toMatchObject({
        spentUsd: 4,
        limitUsd: null,
        remainingUsd: null,
      });
      expect(finance.campaigns).toEqual(
        expect.arrayContaining([
          { id: campaign, name: 'Metrics', spentUsd: 6 },
          { id: null, name: null, spentUsd: 4 },
        ]),
      );
      expect(finance.daily).toHaveLength(31);
      expect(finance.daily[0]).toEqual({ date: '2001-01-01', spentUsd: 1 });
      expect(finance.daily[1]).toEqual({ date: '2001-01-02', spentUsd: 0 });
      expect(finance.daily[30]).toEqual({ date: '2001-01-31', spentUsd: 9 });
      expect(await financeMetrics('1901-02')).toMatchObject({
        totalUsd: 0,
        costPerCompanyUsd: null,
        costPerContactUsd: null,
        daily: expect.any(Array),
      });
      await expect(financeMetrics('2001-13')).rejects.toThrow('Invalid month');

      await client.query(
        "insert into do_not_contact(kind,value_normalized,reason) values('company',$1,'Metrics')",
        [companies[0]],
      );
      // Date boundaries use UTC even with a non-UTC server session.
      await client.query(
        `insert into messages(conversation_id,account_id,to_value,subject,body,status,channel,sent_at,idempotency_key)
        select $1,$2,'test@example.invalid','test','test','sent',channel,sent_at,$3||suffix from (values
        ('email',date_trunc('day',now() at time zone 'UTC') at time zone 'UTC','today'),
        ('telegram',now()-interval '7 days'+interval '1 hour','within'),
        ('telegram',now()-interval '7 days'-interval '1 hour','outside'),
        ('form',now()+interval '1 hour','future')) b(channel,sent_at,suffix)`,
        [conversation, account, randomUUID()],
      );
      const overview = await overviewMetrics(campaign);
      expect(overview.funnel).toEqual({
        found: 6,
        enriched: 4,
        ready: 3,
        contacted: 2,
        replied: 2,
        interested: 1,
        deal: 1,
        refused: 1,
        doNotContact: 2,
      });
      expect(
        overview.channels.find((c) => c.channel === 'email')?.last7Days,
      ).toBe(2);
      expect(overview.channels).toHaveLength(4);
      expect(overview.channels.find((c) => c.channel === 'email')?.today).toBe(
        2,
      );
      expect(
        overview.channels.find((c) => c.channel === 'telegram')?.last7Days,
      ).toBe(1);
      expect(
        overview.channels.find((c) => c.channel === 'form')?.last7Days,
      ).toBe(0);
      expect(await overviewMetrics(randomUUID())).toMatchObject({
        funnel: {
          found: 0,
          enriched: 0,
          ready: 0,
          contacted: 0,
          replied: 0,
          interested: 0,
          deal: 0,
          refused: 0,
          doNotContact: 0,
        },
        failedTasks24h: 0,
      });
      // Failure on a company older than the cohort still counts in the 24h window.
      expect(overview.failedTasks24h).toBe(2);
      expect((await overviewMetrics()).funnel.found).toBe(
        baseline.funnel.found + 6,
      );
      await client.query(
        "insert into company_scores(company_id,campaign_id,score,breakdown) values($1,$2,10,'{}')",
        [companies[4], campaign],
      );
      expect((await overviewMetrics(campaign)).funnel).toMatchObject({
        enriched: 5,
        ready: 3,
      });
      expect((await overviewMetrics(otherCampaign)).funnel.found).toBe(2);
      expect(
        (await overviewMetrics(otherCampaign)).channels.every(
          (c) => c.last7Days === 0,
        ),
      ).toBe(true);
    } finally {
      await client.query(
        'delete from spend_events where service_code=any($1::text[])',
        [[service, unlimited]],
      );
      await client.query('delete from tasks where id=any($1::uuid[])', [tasks]);
      await client.query('delete from messages where account_id=$1', [account]);
      await client.query('delete from conversations where id=$1', [
        conversation,
      ]);
      await client.query('delete from channel_accounts where id=$1', [account]);
      await client.query(
        'delete from contacts where company_id=any($1::uuid[])',
        [companies],
      );
      await client.query(
        'delete from campaign_companies where campaign_id=any($1::uuid[])',
        [[campaign, otherCampaign]],
      );
      await client.query(
        'delete from do_not_contact where value_normalized=$1',
        [companies[0]],
      );
      await client.query('delete from companies where id=any($1::uuid[])', [
        companies,
      ]);
      await client.query('delete from batches where id=$1', [batch]);
      await client.query('delete from campaigns where id=any($1::uuid[])', [
        [campaign, otherCampaign],
      ]);
      await client.query('delete from services where code=any($1::text[])', [
        [service, unlimited],
      ]);
      client.release();
    }
  },
  15000,
);

afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
