import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'),
  email: typeof import('./email.js'),
  forms: typeof import('./forms.js');
let boss: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  // These suites exercise real sending logic; the owner's test-mode allowlist is covered in core.
  await (await import('./index.js')).sonarPool.query(
    "update settings set value='false' where key='send.test_mode'",
  );
  db = await import('./index.js');
  email = await import('./email.js');
  forms = await import('./forms.js');
  const { PgBoss } = await import('pg-boss');
  boss = new PgBoss(process.env.DATABASE_URL!);
  await boss.start();
  await boss.createQueue('message.send');
});
it.skipIf(!enabled)(
  'forms durably claim clicks, serialize concurrent attempts, enforce limits, DNC, domains and modes, persist evidence and audit manual completion',
  async () => {
    const ids = {
      user: randomUUID(),
      campaign: randomUUID(),
      batch: randomUUID(),
      company: randomUUID(),
    };
    const now = new Date('2026-11-12T10:00:00Z');
    const keys = [
      'send.hours',
      'send.time_zones',
      'send.min_gap_seconds',
      'send.max_gap_seconds',
      'send.form_company_daily_limit',
    ];
    const original = (
      await db.sonarPool.query(
        'select key,value from settings where key=any($1::text[])',
        [keys],
      )
    ).rows;
    const set = async (key: string, value: unknown) =>
      db.sonarPool.query(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
        [key, JSON.stringify(value)],
      );
    const accounts: string[] = [];
    const createAccount = async () => {
      const a = await email.createFormAccount(
        {
          name: 'Form test',
          fromAddress: 'sender@example.invalid',
          senderName: 'Test Sender',
          senderPhone: '+380501234567',
          dailyLimit: 100,
        },
        ids.user,
      );
      accounts.push(a.id);
      return a.id;
    };
    let account = '';
    const create = async (
      extra: Partial<Parameters<typeof email.createCompanyMessage>[0]> = {},
    ) =>
      email.createCompanyMessage(
        {
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: account,
          toAddress: 'https://example.invalid/contact',
          body: 'Stub only',
          channel: 'form',
          submit: true,
          idempotencyKey: randomUUID(),
          ...extra,
        },
        ids.user,
      );
    let tick = 0;
    const send = async (
      id: string,
      sender: import('./forms.js').FormSender,
      at = new Date(now.getTime() + ++tick * 1000),
    ) => forms.sendFormMessage(id, randomUUID(), sender, at);
    const sender = vi.fn(
      async (
        _request: import('./forms.js').FormRequest,
        controls: import('./forms.js').FormControls,
      ) => {
        await controls.saveScreenshot('before', Buffer.from('before'));
        await controls.beforeSubmit();
        await controls.saveScreenshot('after', Buffer.from('after'));
        return { status: 'sent' as const, evidence: 'Confirmed stub' };
      },
    );
    try {
      await set('send.hours', {
        start: 0,
        end: 24,
        days: [0, 1, 2, 3, 4, 5, 6],
      });
      await set('send.time_zones', { PL: 'Europe/Warsaw' });
      await set('send.min_gap_seconds', 0);
      await set('send.max_gap_seconds', 0);
      await set('send.form_company_daily_limit', 1);
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Forms test','stub')",
        [ids.user, `${ids.user}@example.invalid`],
      );
      await db.sonarPool.query(
        `insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Forms test','PL','pl','{}','{}','test',1,'{"email":true,"forms":true}','{}','auto','active')`,
        [ids.campaign],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [ids.batch, ids.campaign, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,website,domain,country_code) values($1,$2,'Forms test','ready','https://example.invalid','example.invalid','PL')",
        [ids.company, ids.company],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [ids.campaign, ids.company, ids.batch],
      );
      await db.sonarPool.query(
        `insert into contacts(company_id,kind,value,normalized,source,meta) values($1,'form','https://example.invalid/contact','https://example.invalid/contact','website','{"captcha":"none"}')`,
        [ids.company],
      );
      account = await createAccount();
      const editableAccount = {
        name: 'Form test',
        fromAddress: 'sender@example.invalid',
        senderName: 'Test Sender',
        senderPhone: '',
        dailyLimit: 100,
      };
      expect(
        await email.updateFormAccount(account, editableAccount, ids.user),
      ).toBe(true);
      expect(
        (await email.listFormAccounts()).find((a) => a.id === account)
          ?.senderPhone,
      ).toBe('');
      await expect(
        email.updateFormAccount(
          account,
          { ...editableAccount, senderPhone: '0501234567' },
          ids.user,
        ),
      ).rejects.toThrow('міжнародним');
      await email.updateFormAccount(
        account,
        { ...editableAccount, senderPhone: '+380501234567' },
        ids.user,
      );
      const inputKey = randomUUID(),
        one = await create({ idempotencyKey: inputKey });
      expect((await create({ idempotencyKey: inputKey })).id).toBe(one.id);
      await expect(
        create({ idempotencyKey: inputKey, body: 'different' }),
      ).rejects.toThrow('Ключ');
      await Promise.all([send(one.id, sender), send(one.id, sender)]);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender.mock.calls[0]?.[0]).toMatchObject({
        name: 'Test Sender',
        email: 'sender@example.invalid',
        phone: '+380501234567',
        captcha: 'none',
      });
      expect(await forms.getFormScreenshot(one.id, 'before')).toEqual(
        Buffer.from('before'),
      );
      expect(await forms.getFormScreenshot(one.id, 'after')).toEqual(
        Buffer.from('after'),
      );
      const cap = await create();
      expect(await send(cap.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'company_daily_limit',
      });
      expect(sender).toHaveBeenCalledTimes(1);
      account = await createAccount();
      const otherAccount = await create();
      expect(await send(otherAccount.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'company_daily_limit',
      });
      await set('send.form_company_daily_limit', 100);
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=1,sent_day=$2,attempt_count=1 where id=$1',
        [account, now.toISOString().slice(0, 10)],
      );
      expect(await send(otherAccount.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=100,next_send_at=$2 where id=$1',
        [account, new Date(now.getTime() + 60000)],
      );
      expect(await send(otherAccount.id, sender)).toMatchObject({
        status: 'deferred',
        reasonCode: 'outside_send_hours',
      });
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null where id=$1',
        [account],
      );
      const unknown = await create(),
        uncertain = vi.fn(
          async (
            _r: import('./forms.js').FormRequest,
            c: import('./forms.js').FormControls,
          ) => {
            await c.saveScreenshot('before', Buffer.from('uncertain'));
            await c.beforeSubmit();
            throw Error('Simulated crash after click');
          },
        );
      expect(await send(unknown.id, uncertain)).toMatchObject({
        status: 'paused',
      });
      expect(await send(unknown.id, uncertain)).toMatchObject({
        status: 'paused',
      });
      expect(uncertain).toHaveBeenCalledTimes(1);
      const attempted = (
        await db.sonarPool.query(
          'select first_attempt_at,request_snapshot from messages where id=$1',
          [unknown.id],
        )
      ).rows[0];
      expect(attempted.first_attempt_at).toBeTruthy();
      expect(attempted.request_snapshot.body).toBe('Stub only');
      await expect(
        db.sonarPool.query("update messages set body='changed' where id=$1", [
          unknown.id,
        ]),
      ).rejects.toThrow('immutable');
      expect(await forms.markFormMessageSent(unknown.id, ids.user)).toBe(true);
      expect(await forms.markFormMessageSent(unknown.id, ids.user)).toBe(false);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from activity_log where action='form.manually_sent' and details->>'messageId'=$1",
            [unknown.id],
          )
        ).rows[0].n,
      ).toBe(1);
      const captcha = await create();
      expect(
        await send(captcha.id, async () => ({
          status: 'awaiting_manual',
          reasonUk: 'Потрібна капча',
        })),
      ).toMatchObject({ status: 'paused' });
      expect(
        (await forms.listManualFormMessages()).some((m) => m.id === captcha.id),
      ).toBe(true);
      expect(await send(captcha.id, sender)).toMatchObject({
        status: 'paused',
      });
      await db.sonarPool.query(
        "update tasks set status='paused',result=$2 where payload->>'messageId'=$1",
        [
          captcha.id,
          {
            billingPending: true,
            billingService: 'twocaptcha',
            billingEstimate: 0.01,
            billingAt: new Date().toISOString(),
          },
        ],
      );
      expect(await forms.markFormMessageSent(captcha.id, ids.user)).toBe(true);
      expect(
        (
          await db.sonarPool.query(
            "select status,result from tasks where payload->>'messageId'=$1",
            [captcha.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'paused',
        result: { billingPending: true, billingService: 'twocaptcha' },
      });
      await db.sonarPool.query(
        "update campaigns set send_mode='approval' where id=$1",
        [ids.campaign],
      );
      const approval = await create();
      expect(approval.status).toBe('awaiting_approval');
      expect(await send(approval.id, sender)).toMatchObject({
        status: 'skipped',
      });
      await email.approveMessage(approval.id, ids.user);
      expect(await send(approval.id, sender)).toMatchObject({ status: 'done' });
      await db.sonarPool.query(
        "update campaigns set send_mode='manual' where id=$1",
        [ids.campaign],
      );
      const draft = await create({ submit: false });
      expect(draft.status).toBe('draft');
      await email.submitMessage(draft.id, ids.user);
      expect(await send(draft.id, sender)).toMatchObject({ status: 'done' });
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'form','https://evil.invalid/contact','https://evil.invalid/contact','manual')",
        [ids.company],
      );
      await expect(
        create({ toAddress: 'https://evil.invalid/contact' }),
      ).rejects.toThrow('домену');
      const budgetMessage = await create();
      const {
        rows: [budgetTask],
      } = await db.sonarPool.query(
        "select id from tasks where payload->>'messageId'=$1",
        [budgetMessage.id],
      );
      const budget = await import('./budget.js');
      const paid = vi.fn(async () => ({
        body: { token: 'stub' },
        units: 1,
        costUsd: 0.003,
      }));
      await db.sonarPool.query(
        'update campaigns set budget_usd=0.005 where id=$1',
        [ids.campaign],
      );
      await expect(
        budget.runBudgetedRequest('twocaptcha', 0.01, budgetTask.id, paid),
      ).rejects.toThrow();
      expect(paid).not.toHaveBeenCalled();
      await db.sonarPool.query(
        'update campaigns set budget_usd=1 where id=$1',
        [ids.campaign],
      );
      expect(
        await budget.runBudgetedRequest(
          'twocaptcha',
          0.01,
          budgetTask.id,
          paid,
        ),
      ).toMatchObject({ costUsd: 0.003 });
      await budget.runBudgetedRequest('twocaptcha', 0.01, budgetTask.id, paid);
      expect(paid).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.sonarPool.query(
            'select cost_usd from spend_events where task_id=$1',
            [budgetTask.id],
          )
        ).rows[0].cost_usd,
      ).toBe('0.0030000000');
      const concurrentA = await create();
      account = await createAccount();
      const concurrentB = await create();
      await set('send.form_company_daily_limit', 1);
      const nextDay = new Date('2026-11-13T10:00:00Z');
      const outcomes = await Promise.all([
        send(concurrentA.id, sender, nextDay),
        send(concurrentB.id, sender, nextDay),
      ]);
      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'deferred',
        'done',
      ]);
      const blocked = await create();
      await db.sonarPool.query(
        "insert into do_not_contact(company_id,kind,value_normalized,reason,created_by) values($1,'domain','example.invalid','test',$2)",
        [ids.company, ids.user],
      );
      expect(await send(blocked.id, sender)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
    } finally {
      await db.sonarPool.query(
        "delete from spend_events where task_id in (select id from tasks where payload->>'messageId' in (select m.id::text from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1))",
        [ids.company],
      );
      await db.sonarPool.query(
        "delete from tasks where payload->>'messageId' in (select m.id::text from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1)",
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from messages where conversation_id in (select id from conversations where company_id=$1)',
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query('delete from companies where id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from batches where id=$1', [ids.batch]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        ids.campaign,
      ]);
      await db.sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [accounts],
      );
      await db.sonarPool.query('delete from activity_log where user_id=$1', [
        ids.user,
      ]);
      await db.sonarPool.query('delete from users where id=$1', [ids.user]);
      await db.sonarPool.query(
        'delete from settings where key=any($1::text[])',
        [keys],
      );
      for (const row of original) await set(row.key, row.value);
    }
  },
  30000,
);
afterAll(async () => {
  if (enabled) {
    await (await import('./tasks.js')).closeTaskQueue();
    await boss.stop({ graceful: true });
    await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  }
});
