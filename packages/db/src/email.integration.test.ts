import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EmailSendError } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
let email: typeof import('./email.js');
let tasks: typeof import('./tasks.js');
let admin: import('pg-boss').PgBoss;
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  email = await import('./email.js');
  tasks = await import('./tasks.js');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  await admin.createQueue('message.send');
});
it.skipIf(!enabled)(
  'enforces modes, contact membership and idempotency; serializes accounts, caps attempts, schedules hours and blocks retries safely',
  async () => {
    const ids = {
      user: randomUUID(),
      account: randomUUID(),
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
    const sender = vi.fn(async (request: import('./email.js').EmailRequest) => {
      void request;
      return 'provider-stub';
    });
    const create = async (submit = true) =>
      email.createCompanyMessage(
        {
          companyId: ids.company,
          campaignId: ids.campaign,
          accountId: ids.account,
          toAddress: 'hello@example.invalid',
          subject: 'Test',
          body: 'Stub message only',
          submit,
          idempotencyKey: randomUUID(),
        },
        ids.user,
      );
    const send = async (id: string, at = now) =>
      email.sendEmailMessage(id, randomUUID(), sender, at, () => 0);
    try {
      await set('send.hours', {
        start: 0,
        end: 24,
        days: [0, 1, 2, 3, 4, 5, 6],
      });
      await set('send.time_zones', { PL: 'Europe/Warsaw' });
      await set('send.min_gap_seconds', 0);
      await set('send.max_gap_seconds', 0);
      await db.sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Email test','stub')",
        [ids.user, `${ids.user}@example.invalid`],
      );
      await db.sonarPool.query(
        "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,send_mode,status) values($1,'Email test','PL','pl','{}','{}','test',1,'{\"email\":true}','{}','approval','active')",
        [ids.campaign],
      );
      await db.sonarPool.query(
        "insert into batches(id,campaign_id,number,size,config,request_key) values($1,$2,1,20,'{}',$3)",
        [ids.batch, ids.campaign, randomUUID()],
      );
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,status,domain,country_code) values($1,$2,'Email test','ready','example.invalid','ZZ')",
        [ids.company, ids.company],
      );
      await db.sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
        [ids.campaign, ids.company, ids.batch],
      );
      await db.sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source) values($1,'email','hello@example.invalid','hello@example.invalid','manual')",
        [ids.company],
      );
      await db.sonarPool.query(
        "insert into channel_accounts(id,name,address,daily_limit,owner_id) values($1,'Email test','from@example.invalid',100,$2)",
        [ids.account, ids.user],
      );
      const approval = await create();
      expect(approval.status).toBe('awaiting_approval');
      expect(await send(approval.id)).toMatchObject({ status: 'skipped' });
      expect(sender).not.toHaveBeenCalled();
      expect(await email.approveMessage(approval.id, ids.user)).toBe(true);
      await Promise.all([send(approval.id), send(approval.id)]);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender.mock.calls[0]).toHaveLength(1);
      const sent = (
        await db.sonarPool.query('select * from messages where id=$1', [
          approval.id,
        ])
      ).rows[0];
      expect(sender.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: sent.idempotency_key,
      });
      await expect(
        db.sonarPool.query("update messages set body='changed' where id=$1", [
          approval.id,
        ]),
      ).rejects.toThrow('immutable');
      await db.sonarPool.query(
        "update campaigns set send_mode='manual' where id=$1",
        [ids.campaign],
      );
      const manual = await create(false);
      expect(manual.status).toBe('draft');
      expect(await email.submitMessage(manual.id, ids.user)).toBe(true);
      expect(await send(manual.id)).toMatchObject({ status: 'done' });
      await db.sonarPool.query(
        "update campaigns set send_mode='auto' where id=$1",
        [ids.campaign],
      );
      const tx = await db.sonarPool.connect();
      try {
        await tx.query('begin');
        for (const version of ['draft-v1', 'draft-v2']) {
          const {
            rows: [analysis],
          } = await tx.query(
            "insert into analyses(company_id,campaign_id,version,model,cost_usd,result) values($1,$2,$3,'stub',0,$4) returning id",
            [
              ids.company,
              ids.campaign,
              version,
              { best_channel: 'email', first_message: version },
            ],
          );
          await email.draftFromAnalysis(
            ids.company,
            ids.campaign,
            analysis.id,
            tx,
          );
          await email.draftFromAnalysis(
            ids.company,
            ids.campaign,
            analysis.id,
            tx,
          );
        }
        await tx.query('commit');
      } catch (error) {
        await tx.query('rollback');
        throw error;
      } finally {
        tx.release();
      }
      expect(
        (
          await db.sonarPool.query(
            'select body,status from messages where idempotency_key=$1',
            [`first-message:${ids.company}:${ids.campaign}`],
          )
        ).rows,
      ).toEqual([{ body: 'draft-v1', status: 'queued' }]);
      const modeChanged = await create(false);
      await db.sonarPool.query(
        'update messages set created_by=null where id=$1',
        [modeChanged.id],
      );
      await db.sonarPool.query(
        "update campaigns set send_mode='manual' where id=$1",
        [ids.campaign],
      );
      expect(await send(modeChanged.id)).toMatchObject({
        status: 'paused',
        reasonCode: 'manual_submission_required',
      });
      await db.sonarPool.query(
        "update tasks set status='paused' where type='message.send' and payload->>'messageId'=$1",
        [modeChanged.id],
      );
      expect(await email.submitMessage(modeChanged.id, ids.user)).toBe(true);
      expect(
        (
          await db.sonarPool.query(
            "select status from tasks where type='message.send' and payload->>'messageId'=$1",
            [modeChanged.id],
          )
        ).rows[0].status,
      ).toBe('queued');
      await db.sonarPool.query(
        "update campaigns set send_mode='auto' where id=$1",
        [ids.campaign],
      );
      const automatic = await create(false);
      expect(automatic.status).toBe('queued');
      const input = {
        companyId: ids.company,
        campaignId: ids.campaign,
        accountId: ids.account,
        toAddress: 'hello@example.invalid',
        subject: 'Idempotent',
        body: 'Same',
        idempotencyKey: randomUUID(),
      };
      const duplicate = await Promise.all([
        email.createCompanyMessage(input, ids.user),
        email.createCompanyMessage(input, ids.user),
      ]);
      expect(duplicate[0]?.id).toBe(duplicate[1]?.id);
      await expect(
        email.createCompanyMessage({ ...input, body: 'Changed' }, ids.user),
      ).rejects.toBeInstanceOf(email.EmailValidationError);
      await expect(
        email.createCompanyMessage(
          {
            ...input,
            idempotencyKey: randomUUID(),
            toAddress: 'other@example.invalid',
          },
          ids.user,
        ),
      ).rejects.toBeInstanceOf(email.EmailValidationError);
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=attempt_count where id=$1',
        [ids.account],
      );
      expect(await send(automatic.id)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      expect(
        (await email.getCompanyMessaging(ids.company)).messages.find(
          (m) => m.id === automatic.id,
        )?.scheduledAt,
      ).toBeInstanceOf(Date);
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=100 where id=$1',
        [ids.account],
      );
      await set('send.min_gap_seconds', 120);
      await set('send.max_gap_seconds', 120);
      expect(await send(automatic.id)).toMatchObject({ status: 'done' });
      const gap = await create();
      expect(await send(gap.id)).toMatchObject({ status: 'deferred' });
      expect(
        await send(gap.id, new Date(now.getTime() + 120000)),
      ).toMatchObject({ status: 'done' });
      await set('send.min_gap_seconds', 0);
      await set('send.max_gap_seconds', 0);
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=null where id=$1',
        [ids.account],
      );
      const retry = await create();
      const timeout = vi.fn(async () => {
        throw new EmailSendError(
          'network_unavailable',
          'Невідома доставка',
          true,
        );
      });
      await expect(
        email.sendEmailMessage(retry.id, randomUUID(), timeout, now),
      ).rejects.toMatchObject({ code: 'network_unavailable' });
      const first = (
        await db.sonarPool.query(
          'select first_attempt_at,request_snapshot from messages where id=$1',
          [retry.id],
        )
      ).rows[0];
      await db.sonarPool.query(
        "update channel_accounts set address='changed@example.invalid' where id=$1",
        [ids.account],
      );
      await email.sendEmailMessage(retry.id, randomUUID(), sender, now);
      expect(sender.mock.calls.at(-1)?.[0]).toMatchObject({
        from: 'from@example.invalid',
      });
      expect(
        (
          await db.sonarPool.query(
            'select first_attempt_at from messages where id=$1',
            [retry.id],
          )
        ).rows[0].first_attempt_at,
      ).toEqual(first.first_attempt_at);
      const expired = await create();
      await expect(
        email.sendEmailMessage(expired.id, randomUUID(), timeout, now),
      ).rejects.toThrow();
      expect(
        await email.sendEmailMessage(
          expired.id,
          randomUUID(),
          sender,
          new Date(now.getTime() + 23 * 3600000),
        ),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'email_delivery_uncertain',
      });
      // A retry crossing midnight must reserve today's quota, even with an old key.
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=1,sent_day=null,attempt_count=0,next_send_at=null where id=$1',
        [ids.account],
      );
      const rollover = await create();
      await expect(
        email.sendEmailMessage(
          rollover.id,
          randomUUID(),
          timeout,
          new Date('2026-11-11T22:00:00Z'),
        ),
      ).rejects.toThrow();
      const fresh = await create();
      expect(await send(fresh.id)).toMatchObject({ status: 'done' });
      expect(await send(rollover.id)).toMatchObject({
        status: 'deferred',
        reasonCode: 'daily_limit',
      });
      await db.sonarPool.query(
        'update channel_accounts set daily_limit=100 where id=$1',
        [ids.account],
      );
      const left = await create(),
        right = await create();
      let active = 0,
        maxActive = 0;
      const serialized = async () => {
        active++;
        maxActive = Math.max(active, maxActive);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return 'serialized';
      };
      await Promise.all([
        email.sendEmailMessage(left.id, randomUUID(), serialized, now),
        email.sendEmailMessage(right.id, randomUUID(), serialized, now),
      ]);
      expect(maxActive).toBe(1);
      const permanent = await create();
      expect(
        await email.sendEmailMessage(
          permanent.id,
          randomUUID(),
          async () => {
            throw new EmailSendError('http_422', 'Перевірте адресу', false);
          },
          now,
        ),
      ).toMatchObject({ status: 'failed' });
      await set('send.hours', { start: 9, end: 18, days: [1, 2, 3, 4, 5] });
      const night = await create();
      expect(
        await send(night.id, new Date('2026-11-12T23:00:00Z')),
      ).toMatchObject({ status: 'deferred' });
      const emailBlocked = await create();
      const sendsBeforeDnc = sender.mock.calls.length;
      await db.sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason) values('email','hello@example.invalid','Direct address refusal')",
      );
      expect(await send(emailBlocked.id)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
      expect(sender).toHaveBeenCalledTimes(sendsBeforeDnc);
      await db.sonarPool.query(
        "delete from do_not_contact where kind='email' and value_normalized='hello@example.invalid'",
      );
      const refused = await create();
      await db.sonarPool.query(
        "update companies set status='refused' where id=$1",
        [ids.company],
      );
      expect(await send(refused.id)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
      expect(sender).toHaveBeenCalledTimes(sendsBeforeDnc);
      await db.sonarPool.query(
        "update companies set status='contacted' where id=$1",
        [ids.company],
      );
      const blocked = await create();
      await db.sonarPool.query(
        "insert into do_not_contact(kind,value_normalized,reason) values('domain','example.invalid','Test')",
      );
      expect(await send(blocked.id)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
      await db.sonarPool.query(
        "delete from do_not_contact where kind='domain' and value_normalized='example.invalid'",
      );
      await email.blockCompany(ids.company, ids.user);
      expect(await send(night.id)).toMatchObject({
        status: 'skipped',
        reasonCode: 'do_not_contact',
      });
    } finally {
      const taskIds = (
        await db.sonarPool.query(
          'select id::text from tasks where subject_id=$1',
          [ids.company],
        )
      ).rows.map((r) => r.id);
      await db.sonarPool.query(
        "delete from pgboss.job where name='message.send' and data->>'taskId'=any($1::text[])",
        [taskIds],
      );
      await db.sonarPool.query('delete from tasks where subject_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from messages where conversation_id in(select id from conversations where company_id=$1)',
        [ids.company],
      );
      await db.sonarPool.query(
        'delete from conversations where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query('delete from channel_accounts where id=$1', [
        ids.account,
      ]);
      await db.sonarPool.query(
        'delete from do_not_contact where company_id=$1::uuid or value_normalized=$1::text or value_normalized=any($2::text[])',
        [ids.company, ['example.invalid', 'hello@example.invalid']],
      );
      await db.sonarPool.query('delete from contacts where company_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query(
        'delete from campaign_companies where company_id=$1',
        [ids.company],
      );
      await db.sonarPool.query('delete from analyses where company_id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from companies where id=$1', [
        ids.company,
      ]);
      await db.sonarPool.query('delete from batches where id=$1', [ids.batch]);
      await db.sonarPool.query('delete from campaigns where id=$1', [
        ids.campaign,
      ]);
      await db.sonarPool.query(
        'delete from activity_log where user_id=$1 or entity_id=$2 or entity_id=$3',
        [ids.user, ids.company, ids.account],
      );
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
  if (enabled && db) {
    await tasks.closeTaskQueue();
    await admin.stop();
    await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
  }
});
