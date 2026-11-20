import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import {
  encryptSocialStorageState,
  generateSocialDevice,
  socialProxyFingerprint,
} from '@sonar/core/social-session';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'deduplicates pending Facebook checks without creating messages or changing send counters',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { enqueueFacebookRecipientCheck } =
      await import('./social-recipient-check.js');
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
    await boss.createQueue('social.recipient.check');
    const userId = randomUUID();
    const accountId = randomUUID();
    const companyId = randomUUID();
    const contactId = randomUUID();
    const handle = `sonar${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const nextSendAt = new Date(Date.now() + 3_600_000);
    let taskIds: string[] = [];
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Recipient check test','unused')",
        [userId, `${handle}@example.test`],
      );
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,sent_day,attempt_count,next_send_at,settings) values($1,'facebook','Recipient check test','',$2,'active',20,7,3,$3,'{\"enabled\":true,\"sessionStatus\":\"valid\"}')",
        [accountId, userId, nextSendAt.toISOString()],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1,$2,'Recipient check test','UA')",
        [companyId, `s8-${companyId}`],
      );
      await sonarPool.query(
        "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,'social',$3,$3,'website')",
        [contactId, companyId, `https://www.facebook.com/${handle}/`],
      );
      const [first, second] = await Promise.all([
        enqueueFacebookRecipientCheck(companyId, contactId, userId),
        enqueueFacebookRecipientCheck(companyId, contactId, userId),
      ]);
      taskIds = [first.id, second.id];
      expect(first.id).toBe(second.id);
      expect([first.created, second.created].sort()).toEqual([false, true]);
      const { rows } = await sonarPool.query(
        `select
          (select count(*)::int from tasks where type='social.recipient.check' and payload->>'contactId'=$1 and status in ('queued','running')) as pending,
          (select count(*)::int from messages where account_id=$2) as messages,
          sent_day,attempt_count,next_send_at
         from channel_accounts where id=$2`,
        [contactId, accountId],
      );
      expect(rows[0]).toMatchObject({
        pending: 1,
        messages: 0,
        sent_day: '7',
        attempt_count: 3,
      });
      expect(new Date(rows[0].next_send_at).toISOString()).toBe(
        nextSendAt.toISOString(),
      );
    } finally {
      if (taskIds.length) {
        await sonarPool.query(
          "delete from pgboss.job where name='social.recipient.check' and data->>'taskId'=any($1::text[])",
          [taskIds],
        );
        await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
          taskIds,
        ]);
      }
      await sonarPool.query('delete from contacts where id=$1', [contactId]);
      await sonarPool.query('delete from companies where id=$1', [companyId]);
      await sonarPool.query('delete from channel_accounts where id=$1', [
        accountId,
      ]);
      await sonarPool.query('delete from users where id=$1', [userId]);
      await boss.stop({ graceful: true, timeout: 5000 });
    }
  },
);

it.skipIf(!enabled)(
  'leaves recipient-check session, counters, timers, and queued actions unchanged on login/checkpoint while normal checks still pause the account',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { withSocialSessionCheck } = await import('./social-accounts.js');
    const { PgBoss } = await import('pg-boss');
    const oldSecret = process.env.AUTH_SECRET;
    const oldProxies = process.env.SOCIAL_PROXY_URLS;
    const secret = 'recipient-mode-integration-secret-at-least-32';
    const proxyUrl = 'http://proxy.invalid:8000';
    process.env.AUTH_SECRET = secret;
    process.env.SOCIAL_PROXY_URLS = proxyUrl;
    const accountId = randomUUID();
    const currentCheckTaskId = randomUUID();
    const queuedCheckTaskId = randomUUID();
    const queuedKeepaliveTaskId = randomUUID();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const storageStateEncrypted = encryptSocialStorageState(
      JSON.stringify([
        {
          name: 'session',
          value: 'synthetic-cookie',
          domain: '.facebook.com',
          session: true,
        },
      ]),
      'facebook',
      secret,
    );
    const boss = new PgBoss(process.env.DATABASE_URL!);
    try {
      await boss.start();
      await boss.createQueue('social.session.check');
      await boss.createQueue('social.session.keepalive');
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,status,daily_limit,sent_day,attempt_count,next_send_at,settings) values($1,'facebook','Recipient mode test','', 'active',20,$2,4,$3,$4)",
        [
          accountId,
          now.toISOString().slice(0, 10),
          new Date(now.getTime() + 600_000),
          {
            enabled: true,
            sessionStatus: 'valid',
            sessionCheckTimeoutCount: 2,
            sessionCheckReason: null,
            checkedAt: yesterday.toISOString(),
            nextKeepaliveAt: new Date(now.getTime() + 3_600_000).toISOString(),
            lastKeepaliveAt: yesterday.toISOString(),
            socialAction: {
              day: yesterday.toISOString().slice(0, 10),
              counts: { check: 3, keepalive: 2, send: 4 },
              nextAt: yesterday.toISOString(),
            },
            storageStateEncrypted,
            device: generateSocialDevice('facebook', '157.0.0.0'),
            proxyIndex: 0,
            proxyFingerprint: socialProxyFingerprint({ server: proxyUrl }),
          },
        ],
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,status,payload) values($1,'social.recipient.check',$2,'running',$7),($3,'social.session.check',$4,'queued',$7),($5,'social.session.keepalive',$6,'queued',$7)",
        [
          currentCheckTaskId,
          `recipient:${currentCheckTaskId}`,
          queuedCheckTaskId,
          `check:${queuedCheckTaskId}`,
          queuedKeepaliveTaskId,
          `keepalive:${queuedKeepaliveTaskId}`,
          { accountId },
        ],
      );
      const snapshot = async () => {
        const { rows: accounts } = await sonarPool.query(
          'select status,sent_day,attempt_count,next_send_at,settings from channel_accounts where id=$1',
          [accountId],
        );
        const { rows: tasks } = await sonarPool.query(
          "select id,type,status,reason_code,reason_uk,finished_at from tasks where payload->>'accountId'=$1 and type like 'social.%' order by id",
          [accountId],
        );
        return { account: accounts[0], tasks };
      };
      const before = await snapshot();
      for (const reason of ['login_required', 'checkpoint'] as const) {
        const recipientOutcome = await withSocialSessionCheck(
          accountId,
          async () => ({ valid: false, reason }),
          now,
          'recipient',
          currentCheckTaskId,
        );
        expect(recipientOutcome).toMatchObject({
          status: 'paused',
          reasonCode: `social_session_${reason}`,
          reasonUk: expect.stringMatching(/[А-ЯІЇЄа-яіїє]/),
          result: { valid: false },
        });
        expect(await snapshot()).toEqual(before);
      }

      const normalCheckOutcome = await withSocialSessionCheck(
        accountId,
        async () => ({ valid: false, reason: 'checkpoint' as const }),
        new Date(now.getTime() + 120_000),
        'check',
        currentCheckTaskId,
      );
      expect(normalCheckOutcome).toMatchObject({
        status: 'paused',
        reasonCode: 'social_session_checkpoint',
      });
      const { rows: changed } = await sonarPool.query(
        "select status,settings->>'sessionStatus' as session_status from channel_accounts where id=$1",
        [accountId],
      );
      expect(changed[0]).toEqual({
        status: 'paused',
        session_status: 'invalid',
      });
    } finally {
      await sonarPool.query(
        "delete from pgboss.job where data->>'taskId' = any($1::text[])",
        [[currentCheckTaskId, queuedCheckTaskId, queuedKeepaliveTaskId]],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        [currentCheckTaskId, queuedCheckTaskId, queuedKeepaliveTaskId],
      ]);
      await sonarPool.query(
        'delete from account_health_events where account_id=$1',
        [accountId],
      );
      await sonarPool.query('delete from channel_accounts where id=$1', [
        accountId,
      ]);
      await boss.stop({ graceful: true, timeout: 5000 });
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
    }
  },
);

afterAll(async () => {
  if (!enabled || !process.env.DATABASE_URL) return;
  const { sonarPool } = await import('./index.js');
  await sonarPool.end();
});
