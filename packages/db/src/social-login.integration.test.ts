import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';

it.skipIf(process.env.RUN_DB_TESTS !== '1')(
  'queues encrypted credentials, serializes login, accepts codes while locked, limits retries and recovers lost contexts',
  async () => {
    const { sonarPool } = await import('./index.js');
    // Email imports social accounts too; exercise the cycle's alternate entry point.
    await import('./email.js');
    const accounts = await import('./social-accounts.js');
    const tasks = await import('./tasks.js');
    const { encryptSocialLoginCode, decryptSocialCredentials } =
      await import('@sonar/core/social-login');
    const actor = randomUUID();
    const oldSecret = process.env.AUTH_SECRET,
      oldProxies = process.env.SOCIAL_PROXY_URLS;
    process.env.AUTH_SECRET = 'credential-login-integration-secret-at-least-32';
    process.env.SOCIAL_PROXY_URLS =
      'http://proxy.invalid:8000,http://linkedin.invalid:8000';
    const ids: string[] = [];
    const state = {
      cookies: [
        {
          name: 'sid',
          value: 'private-session',
          domain: '.facebook.com',
          session: true,
        },
      ],
      origins: [],
    };
    const credentials = {
      login: 'private-login@example.test',
      password: 'private-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    };
    const settings = async (id: string) =>
      (
        await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [id],
        )
      ).rows[0].settings;
    const run = async (
      id: string,
      taskId: string,
      callback: Parameters<typeof accounts.withSocialCredentialLogin>[2],
    ) => {
      const outcome = await accounts.withSocialCredentialLogin(
        id,
        taskId,
        callback,
      );
      await sonarPool.query(
        "update tasks set status=$2::task_status,result=coalesce(result,'{}'::jsonb)||$3::jsonb where id=$1",
        [
          taskId,
          outcome.status,
          'result' in outcome ? (outcome.result ?? {}) : {},
        ],
      );
      return outcome;
    };
    try {
      await tasks.boss.start();
      await tasks.boss.createQueue('social.session.login');
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Credential login test','unused')",
        [actor, `${actor}@example.test`],
      );
      const saved = await accounts.saveSocialAccount(
        { network: 'facebook', name: 'Credential only', dailyLimit: 20 },
        actor,
      );
      ids.push(saved.id);
      const first = await accounts.saveSocialCredentials(
        saved.id,
        credentials,
        actor,
      );
      expect(first.created).toBe(true);
      expect(
        await accounts.queueSocialCredentialLogin(saved.id, actor),
      ).toEqual({ id: first.id, created: false });
      await expect(
        accounts.saveSocialCredentials(saved.id, credentials, randomUUID()),
      ).rejects.toThrow();
      expect(JSON.stringify(await settings(saved.id))).not.toMatch(
        /private-login|private-password|JBSWY/,
      );
      const fail = vi.fn(async (_account, session, actual) => {
        expect(session.proxy.server).toBe('http://proxy.invalid:8000');
        expect(session.storageState).toEqual({ cookies: [], origins: [] });
        expect(actual).toEqual(credentials);
        return { valid: false, reason: 'wrong_password' as const };
      });
      expect(await run(saved.id, first.id!, fail)).toMatchObject({
        status: 'paused',
        reasonCode: 'social_login_wrong_password',
      });
      await expect(
        accounts.queueSocialCredentialLogin(saved.id, actor),
      ).rejects.toThrow();
      expect(
        await accounts.saveSocialCredentials(saved.id, credentials, actor),
      ).toEqual({ id: null, created: false });
      expect((await settings(saved.id)).loginBlocked).toBe(true);
      expect(await tasks.retryTask(first.id!, actor)).toBe(false);
      const tomorrowBlocked = vi.fn();
      const blockedTask = (
        await sonarPool.query(
          "insert into tasks(type,idempotency_key,payload) values('social.session.login',$1,$2) returning id",
          [`blocked-login:${randomUUID()}`, { accountId: saved.id }],
        )
      ).rows[0].id;
      expect(
        await accounts.withSocialCredentialLogin(
          saved.id,
          blockedTask,
          tomorrowBlocked,
          new Date(Date.now() + 86400000),
        ),
      ).toMatchObject({ status: 'skipped', reasonCode: 'social_login_limit' });
      expect(tomorrowBlocked).not.toHaveBeenCalled();
      await sonarPool.query("update tasks set status='skipped' where id=$1", [
        blockedTask,
      ]);
      const passwordCipher = (await settings(saved.id)).credentialsEncrypted;
      await accounts.updateSocialAccount(
        saved.id,
        { dailyLimit: 25, keepaliveEnabled: false },
        actor,
      );
      expect((await settings(saved.id)).credentialsEncrypted).toBe(
        passwordCipher,
      );
      expect((await settings(saved.id)).loginBlocked).toBe(true);
      const second = await accounts.saveSocialCredentials(
        saved.id,
        { password: 'actually-updated-password' },
        actor,
      );
      const login = run(
        saved.id,
        second.id!,
        async (_account, session, actual, challenge) => {
          expect(actual.password).toBe('actually-updated-password');
          expect(await challenge.waitForCode('email')).toBe('123456');
          await session.persistStorageState!(state);
          return { valid: true };
        },
      );
      await vi.waitFor(
        async () =>
          expect((await settings(saved.id)).loginChallengeKind).toBe('email'),
        { timeout: 5000 },
      );
      expect((await accounts.listSocialSessionNotices(actor)).length).toBe(1);
      const guard = await sonarPool.connect();
      try {
        expect(
          (
            await guard.query(
              "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
              [saved.id],
            )
          ).rows[0].locked,
        ).toBe(false);
      } finally {
        guard.release();
      }
      await expect(
        accounts.submitSocialLoginCode(saved.id, '123456', randomUUID()),
      ).rejects.toThrow();
      expect(
        await accounts.submitSocialLoginCode(saved.id, '123456', actor),
      ).toBe(true);
      expect(JSON.stringify(await settings(saved.id))).not.toContain('123456');
      expect(await login).toMatchObject({ status: 'done' });
      expect(await accounts.listSocialSessionNotices(actor)).toEqual([]);
      expect(await settings(saved.id)).not.toHaveProperty('loginCodeEncrypted');
      await expect(
        accounts.submitSocialLoginCode(saved.id, '123456', actor),
      ).rejects.toThrow();
      const duplicate = vi.fn();
      await accounts.withSocialCredentialLogin(saved.id, second.id!, duplicate);
      expect(duplicate).not.toHaveBeenCalled();
      expect((await settings(saved.id)).loginAttemptCount).toBe(2);
      const publicAccount = (await accounts.listSocialAccounts(actor)).find(
        (a) => a.id === saved.id,
      );
      expect(publicAccount).toMatchObject({
        hasCredentials: true,
        hasTotpSecret: true,
        loginBlocked: false,
        loginChallengeKind: null,
      });
      expect(JSON.stringify(publicAccount)).not.toMatch(
        /private-|actually-updated|Encrypted|JBSWY|123456/,
      );
      // S1 tries one automatic relogin, then a challenge surfaces Needs Action.
      await accounts.withSocialSessionCheck(saved.id, async () => ({
        valid: false,
        reason: 'login_required',
      }));
      const auto = (
        await sonarPool.query(
          "select id,payload from tasks where type='social.session.login' and payload->>'accountId'=$1 and payload->>'automatic'='true'",
          [saved.id],
        )
      ).rows[0];
      expect(auto).toBeDefined();
      expect(await accounts.listSocialSessionNotices(actor)).toEqual([]);
      expect(
        await run(saved.id, auto.id, async () => ({
          valid: false,
          reason: 'captcha',
        })),
      ).toMatchObject({ status: 'paused' });
      expect(
        (await accounts.listSocialAccounts(actor)).find(
          (a) => a.id === saved.id,
        )?.loginChallengeKind,
      ).toBe('captcha');
      await expect(
        accounts.queueSocialCredentialLogin(saved.id, actor),
      ).rejects.toThrow();
      await sonarPool.query(
        'update channel_accounts set settings=settings||\'{"loginBlocked":true}\'::jsonb where id=$1',
        [saved.id],
      );
      expect(
        await accounts.saveSocialCredentials(
          saved.id,
          { password: 'updated-despite-daily-quota' },
          actor,
        ),
      ).toEqual({
        id: null,
        created: false,
        reasonCode: 'social_login_daily_limit',
      });
      expect((await settings(saved.id)).loginBlocked).toBe(false);
      expect(
        decryptSocialCredentials(
          (await settings(saved.id)).credentialsEncrypted,
          process.env.AUTH_SECRET!,
        ).password,
      ).toBe('updated-despite-daily-quota');
      const autoBase = Date.now();
      await accounts.withSocialSessionCheck(
        saved.id,
        async () => ({ valid: true }),
        new Date(autoBase + 3600000),
      );
      expect((await settings(saved.id)).loginAutoAttempted).toBe(false);
      await accounts.withSocialSessionCheck(
        saved.id,
        async () => ({ valid: false, reason: 'login_required' }),
        new Date(autoBase + 7200000),
      );
      expect(
        (
          await sonarPool.query(
            "select count(*)::int as count from tasks where type='social.session.login' and payload->>'accountId'=$1 and payload->>'automatic'='true'",
            [saved.id],
          )
        ).rows[0].count,
      ).toBe(1);
      expect((await accounts.listSocialSessionNotices(actor)).length).toBe(1);
      const nextDay = new Date(autoBase + 25 * 3600000);
      await accounts.withSocialSessionCheck(
        saved.id,
        async () => ({ valid: false, reason: 'login_required' }),
        nextDay,
      );
      const nextAuto = (
        await sonarPool.query(
          "select id from tasks where type='social.session.login' and payload->>'accountId'=$1 and payload->>'automatic'='true' and id<>$2",
          [saved.id, auto.id],
        )
      ).rows[0];
      expect(nextAuto).toBeDefined();
      expect(
        await accounts.withSocialCredentialLogin(
          saved.id,
          nextAuto.id,
          async () => ({ valid: false, reason: 'login_failed' }),
          nextDay,
        ),
      ).toMatchObject({ status: 'paused' });
      expect(await settings(saved.id)).toMatchObject({
        loginAttemptDay: nextDay.toISOString().slice(0, 10),
        loginAttemptCount: 1,
      });
      // A restart cannot replay a code into a fresh browser, even before its old expiry.
      const stale = await accounts.saveSocialAccount(
        { network: 'facebook', name: 'Lost context', dailyLimit: 20 },
        actor,
      );
      ids.push(stale.id);
      const queued = await accounts.saveSocialCredentials(
        stale.id,
        credentials,
        actor,
      );
      await sonarPool.query(
        "update tasks set status='paused',result='{\"credentialAttempted\":true}' where id=$1",
        [queued.id],
      );
      await sonarPool.query(
        'update channel_accounts set settings=settings||$2::jsonb where id=$1',
        [
          stale.id,
          {
            loginTaskId: queued.id,
            loginChallengeKind: 'sms',
            loginChallengeExpiresAt: new Date(
              Date.now() + 600000,
            ).toISOString(),
            loginCodeEncrypted: encryptSocialLoginCode(
              '654321',
              process.env.AUTH_SECRET!,
            ),
          },
        ],
      );
      expect(
        await accounts.reconcileSocialCredentialLogins(),
      ).toBeGreaterThanOrEqual(1);
      expect(await settings(stale.id)).not.toHaveProperty('loginTaskId');
      expect(await settings(stale.id)).not.toHaveProperty('loginCodeEncrypted');
      expect(
        (
          await sonarPool.query(
            'select status,reason_code from tasks where id=$1',
            [queued.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'failed',
        reason_code: 'social_login_context_lost',
      });
      await expect(
        accounts.submitSocialLoginCode(stale.id, '654321', actor),
      ).rejects.toThrow();
      const replay = vi.fn();
      await accounts.withSocialCredentialLogin(stale.id, queued.id!, replay);
      expect(replay).not.toHaveBeenCalled();
      // A failed manual attempt never creates a new automatic attempt by itself.
      const manual = await accounts.queueSocialCredentialLogin(stale.id, actor);
      await run(stale.id, manual.id!, async () => ({
        valid: false,
        reason: 'login_failed',
      }));
      expect((await settings(stale.id)).loginRecoveryPending).toBe(false);
      await accounts.reconcileSocialCredentialLogins();
      const autoCount = async () =>
        (
          await sonarPool.query(
            "select count(*)::int as count from tasks where type='social.session.login' and payload->>'accountId'=$1 and payload->>'automatic'='true'",
            [stale.id],
          )
        ).rows[0].count;
      expect(await autoCount()).toBe(0);
      // Send/fetch/inbox loss persists intent without dispatch inside their transaction.
      const connection = await sonarPool.connect();
      try {
        await connection.query(
          "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
          [stale.id],
        );
        await accounts.pauseSocialFetchSession(
          connection,
          stale.id,
          'login_required',
        );
        expect((await settings(stale.id)).loginRecoveryPending).toBe(true);
        expect(await autoCount()).toBe(0);
      } finally {
        await accounts.releaseSocialFetchSession(connection, stale.id);
        connection.release();
      }
      await accounts.reconcileSocialCredentialLogins();
      expect(await autoCount()).toBe(1);
      expect((await settings(stale.id)).loginRecoveryPending).not.toBe(true);
      await accounts.reconcileSocialCredentialLogins();
      expect(await autoCount()).toBe(1);

      const createdWithPassword =
        await accounts.createSocialAccountWithCredentials(
          {
            network: 'linkedin',
            name: 'Created with credentials',
            dailyLimit: 20,
            proxyIndex: 1,
            login: 'new-private-login',
            password: 'new-private-password',
            totpSecret: 'JBSWY3DPEHPK3PXP',
          },
          actor,
        );
      ids.push(createdWithPassword.id);
      const createdSettings = await settings(createdWithPassword.id);
      expect(createdSettings).not.toHaveProperty('storageStateEncrypted');
      expect(
        decryptSocialCredentials(
          createdSettings.credentialsEncrypted,
          process.env.AUTH_SECRET!,
        ),
      ).toEqual({
        login: 'new-private-login',
        password: 'new-private-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      });
      expect(
        (
          await sonarPool.query(
            "select status,payload from tasks where id=$1 and type='social.session.login'",
            [createdWithPassword.loginTaskId],
          )
        ).rows[0],
      ).toEqual({
        status: 'queued',
        payload: { accountId: createdWithPassword.id, automatic: false },
      });
    } finally {
      await sonarPool.query(
        "delete from pgboss.job where name='social.session.login' and data->>'taskId' in (select id::text from tasks where payload->>'accountId'=any($1::text[]))",
        [ids],
      );
      await sonarPool.query(
        "delete from tasks where payload->>'accountId'=any($1::text[])",
        [ids],
      );
      await sonarPool.query(
        'delete from activity_log where user_id=$1 or entity_id=any($2::text[])',
        [actor, ids],
      );
      await sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query('delete from users where id=$1', [actor]);
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
    }
  },
  20000,
);
