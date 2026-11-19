import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  resolveSocialSession,
  socialSessionCheckReasons,
} from '@sonar/core/social-session';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'only lets the channel account owner retry session management tasks',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { retryTask } = await import('./tasks.js');
    const owner = randomUUID(),
      other = randomUUID(),
      accountId = randomUUID(),
      taskId = randomUUID();
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Owner','x'),($3,$4,'Other','x')",
        [owner, `${owner}@example.test`, other, `${other}@example.test`],
      );
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit) values($1,'facebook','Owned account','',$2,'paused',20)",
        [accountId, owner],
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,status,payload) values($1,'social.session.check',$1::uuid::text,'paused',$2)",
        [taskId, { accountId }],
      );
      expect(await retryTask(taskId, other)).toBe(false);
      expect(
        (
          await sonarPool.query('select status from tasks where id=$1', [
            taskId,
          ])
        ).rows[0].status,
      ).toBe('paused');
    } finally {
      await sonarPool.query('delete from tasks where id=$1', [taskId]);
      await sonarPool.query('delete from channel_accounts where id=$1', [
        accountId,
      ]);
      await sonarPool.query('delete from users where id=any($1::uuid[])', [
        [owner, other],
      ]);
    }
  },
);
it.skipIf(!enabled)(
  'stores social cookies privately, enforces ownership and pauses a changed pinned proxy',
  async () => {
    const { sonarPool } = await import('./index.js');
    const accounts = await import('./social-accounts.js');
    const actor = randomUUID(),
      other = randomUUID();
    const oldSecret = process.env.AUTH_SECRET,
      oldProxies = process.env.SOCIAL_PROXY_URLS;
    const created: string[] = [];
    // Advance past the shared action gap while testing session classifications.
    let checkAt = Date.parse('2026-11-12T00:00:00Z');
    const checkSession = (
      id: string,
      check: Parameters<typeof accounts.withSocialSessionCheck>[1],
    ) => {
      const at = new Date(checkAt);
      checkAt += 120000;
      return accounts.withSocialSessionCheck(id, check, at);
    };

    process.env.AUTH_SECRET = 'social-account-integration-secret-at-least-32';
    process.env.SOCIAL_PROXY_URLS =
      'http://user:private-proxy-password@proxy.example:8000,http://second.example:8000';
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Social account test','unused'),($3,$4,'Other actor','unused')",
        [actor, `${actor}@example.test`, other, `${other}@example.test`],
      );
      for (const network of ['instagram', 'facebook', 'linkedin'] as const) {
        const ownerBrowser = {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36',
          userAgentData: {
            brands: [{ brand: 'Google Chrome', version: '157' }],
            platform: 'Windows',
            mobile: false,
          },
          screen: { width: 2560, height: 1313 },
          viewport: { width: 2560, height: 1313 },
          devicePixelRatio: 1,
          timeZone: 'Europe/Kyiv',
          language: 'uk-UA',
          languages: ['uk-UA', 'uk'],
        };
        const cookiesJson = JSON.stringify([
          {
            name: 'session',
            value: 'private-social-cookie',
            domain: `.${network}.com`,
            session: true,
          },
        ]);
        const saved = await accounts.saveSocialAccount(
          {
            network,
            name: `${network} test`,
            dailyLimit: 20,
            cookiesJson,
            ownerBrowser,
            proxyIndex: 0,
          },
          actor,
        );
        created.push(saved.id);
        const list = (await accounts.listSocialAccounts()).find(
          (row) => row.id === saved.id,
        )!;
        expect(list).toMatchObject({
          network,
          dailyLimit: 20,
          status: 'paused',
          sessionStatus: 'pending',
          proxyIndex: 0,
        });
        expect(JSON.stringify(list)).not.toMatch(
          /private-social-cookie|private-proxy-password|cookiesEncrypted|proxyFingerprint|settings/,
        );
        const {
          rows: [stored],
        } = await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [saved.id],
        );
        expect(stored.settings.storageStateEncrypted).not.toContain(
          'private-social-cookie',
        );
        expect(stored.settings).toMatchObject({
          deviceSource: 'owner_browser',
          device: {
            userAgent: ownerBrowser.userAgent,
            viewport: { width: 1920, height: 984 },
            screen: ownerBrowser.screen,
          },
        });
        expect(
          resolveSocialSession(
            { channel: network, settings: stored.settings },
            process.env.AUTH_SECRET!,
            process.env.SOCIAL_PROXY_URLS!,
          ).device,
        ).toEqual(stored.settings.device);
        const originalStorage = stored.settings.storageStateEncrypted;
        await accounts.updateSocialDevice(
          saved.id,
          {
            ...ownerBrowser,
            viewport: { width: 1440, height: 900 },
          },
          actor,
        );
        const {
          rows: [updated],
        } = await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [saved.id],
        );
        expect(updated.settings.device.viewport).toEqual({
          width: 1440,
          height: 900,
        });
        expect(updated.settings.deviceSource).toBe('owner_browser');
        expect(updated.settings.storageStateEncrypted).toBe(originalStorage);
        await expect(
          accounts.updateSocialAccount(saved.id, { dailyLimit: 5 }, other),
        ).rejects.toThrow('Акаунт соцмережі не знайдено.');
        await expect(
          accounts.updateSocialAccount(saved.id, { enabled: true }, actor),
        ).rejects.toThrow('Спочатку перевірте сесію');
        const check = vi.fn(async () => ({ valid: true }));
        expect(await checkSession(saved.id, check)).toMatchObject({
          status: 'done',
        });
        expect(check).toHaveBeenCalledOnce();
        if (network === 'linkedin' || network === 'facebook') {
          const diagnostic = {
            version: 1,
            stage: 'auth',
            urlKind: network === 'facebook' ? 'home' : 'feed',
            navigationHttpStatus: 200,
            errorKind: 'timeout',
            ...(network === 'facebook'
              ? {
                  semanticAuthImplemented: false as const,
                  page: {
                    lang: 'ru' as const,
                    readyState: 'complete' as const,
                    bodyRendered: true,
                    bodyTextLength: '100_999' as const,
                    scanTruncated: false,
                    visible: {
                      busy: 0,
                      progress: 0,
                      dialog: 1,
                      form: 1,
                      password: 0,
                      navigation: 1,
                      banner: 1,
                      main: 1,
                    },
                    names: {
                      home: 0,
                      menu: 1,
                      account: 0,
                      your_profile: 1,
                      allow_all_cookies: 0,
                      decline_optional_cookies: 0,
                    },
                    hrefs: {
                      home: 1,
                      profile: 2,
                      messages: 1,
                      me: 0,
                      login: 0,
                      other: 2,
                    },
                  },
                }
              : {}),
            visible: {
              legacyAuth: 0,
              semanticAuth: 0,
              captcha: 0,
              checkpoint: 0,
              login: 0,
            },
          } as const;
          for (const reason of Object.keys(
            socialSessionCheckReasons,
          ) as (keyof typeof socialSessionCheckReasons)[]) {
            const outcome = await checkSession(saved.id, async () => ({
              valid: false,
              reason,
              diagnostic: {
                ...diagnostic,
                rawUrl: 'https://private.test/?token=secret',
                ...(diagnostic.page
                  ? {
                      page: {
                        ...diagnostic.page,
                        rawText: 'private secret',
                        names: {
                          ...diagnostic.page.names,
                          rawAria: 'private',
                        },
                        hrefs: {
                          ...diagnostic.page.hrefs,
                          other: 999,
                          rawUrl: 'secret',
                        },
                      },
                    }
                  : {}),
              },
            }));
            expect(outcome).toMatchObject({
              status: 'paused',
              reasonCode: `social_session_${reason}`,
              reasonUk: socialSessionCheckReasons[reason],
              result: { valid: false, diagnostic },
            });
            expect(JSON.stringify(outcome)).not.toMatch(
              /secret|private|rawUrl/,
            );
            expect(
              (await accounts.listSocialAccounts()).find(
                (row) => row.id === saved.id,
              ),
            ).toMatchObject({
              status: 'paused',
              sessionStatus: [
                'login_required',
                'cookies_invalid',
                'captcha',
                'checkpoint',
              ].includes(reason)
                ? 'invalid'
                : 'unconfirmed',
              sessionCheckReason: reason,
              reasonUk: expect.stringContaining(
                socialSessionCheckReasons[reason],
              ),
            });
            expect(
              (
                await sonarPool.query(
                  'select settings from channel_accounts where id=$1',
                  [saved.id],
                )
              ).rows[0].settings.storageStateEncrypted,
            ).toBe(stored.settings.storageStateEncrypted);
            if (
              [
                'captcha',
                'checkpoint',
                'action_blocked',
                'rate_limit',
              ].includes(reason)
            ) {
              await expect(
                accounts.updateSocialAccount(
                  saved.id,
                  { enabled: true },
                  actor,
                ),
              ).resolves.toBe(true);
              expect(
                (
                  await sonarPool.query(
                    'select settings from channel_accounts where id=$1',
                    [saved.id],
                  )
                ).rows[0].settings.healthAutoPaused,
              ).toBe(false);
            } else
              await expect(
                accounts.updateSocialAccount(
                  saved.id,
                  { enabled: true },
                  actor,
                ),
              ).rejects.toThrow('Спочатку перевірте сесію');
          }
          const unsafe = await checkSession(saved.id, async () => {
            throw Error('https://user:secret@proxy.test/?cookies=secret');
          });
          expect(unsafe).toMatchObject({
            reasonUk: socialSessionCheckReasons.unknown_auth,
            result: { valid: false },
          });
          expect(unsafe.result).toEqual({ valid: false });
          expect(
            JSON.stringify(
              (await accounts.listSocialAccounts()).find(
                (row) => row.id === saved.id,
              ),
            ),
          ).not.toContain('secret');
          expect(await checkSession(saved.id, check)).toEqual({
            status: 'done',
            result: { valid: true },
          });
          expect(
            (await accounts.listSocialAccounts()).find(
              (row) => row.id === saved.id,
            ),
          ).toMatchObject({
            status: 'active',
            sessionStatus: 'valid',
            sessionCheckReason: null,
            reasonUk: null,
          });
        }
        await accounts.updateSocialAccount(
          saved.id,
          { enabled: false, dailyLimit: 5 },
          actor,
        );
        await checkSession(saved.id, check);
        expect(
          (await accounts.listSocialAccounts()).find(
            (row) => row.id === saved.id,
          ),
        ).toMatchObject({
          status: 'disabled',
          dailyLimit: 5,
          sessionStatus: 'valid',
        });
        await accounts.updateSocialAccount(saved.id, { enabled: true }, actor);
        process.env.SOCIAL_PROXY_URLS = process.env
          .SOCIAL_PROXY_URLS!.split(',')
          .reverse()
          .join(',');
        check.mockClear();
        expect(await checkSession(saved.id, check)).toMatchObject({
          status: 'paused',
        });
        expect(check).not.toHaveBeenCalled();
        expect(
          (await accounts.listSocialAccounts()).find(
            (row) => row.id === saved.id,
          ),
        ).toMatchObject({
          status: 'paused',
          sessionStatus: 'unconfirmed',
          sessionCheckReason: 'proxy',
        });
        process.env.SOCIAL_PROXY_URLS = process.env
          .SOCIAL_PROXY_URLS!.split(',')
          .reverse()
          .join(',');
        await accounts.updateSocialAccount(saved.id, { proxyIndex: 1 }, actor);
        expect(
          (await accounts.listSocialAccounts()).find(
            (row) => row.id === saved.id,
          ),
        ).toMatchObject({
          sessionStatus: 'pending',
          reasonUk: 'Проксі змінено. Можлива перевірка входу.',
        });
        await accounts.updateSocialAccount(saved.id, { cookiesJson }, actor);
        expect(
          (await accounts.listSocialAccounts()).find(
            (row) => row.id === saved.id,
          ),
        ).toMatchObject({ status: 'paused', sessionStatus: 'pending' });
      }
    } finally {
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
      await sonarPool.query(
        'delete from activity_log where user_id=any($1::uuid[])',
        [[actor, other]],
      );
      await sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [created],
      );
      await sonarPool.query('delete from users where id=any($1::uuid[])', [
        [actor, other],
      ]);
    }
  },
);

it.skipIf(!enabled)(
  'removes social credentials and pending work while preserving conversation and message history',
  async () => {
    const { sonarPool } = await import('./index.js');
    const accounts = await import('./social-accounts.js');
    const actor = randomUUID(),
      other = randomUUID(),
      accountId = randomUUID(),
      otherAccountId = randomUUID(),
      conversationId = randomUUID(),
      inboundId = randomUUID(),
      outboundId = randomUUID();
    const taskIds = Array.from({ length: 5 }, () => randomUUID());
    const foreignTask = randomUUID();
    const oldSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'social-delete-integration-secret-at-least-32';
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Social deletion test','unused'),($3,$4,'Other owner','unused')",
        [actor, `${actor}@example.test`, other, `${other}@example.test`],
      );
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,settings) values($1,'facebook','Delete test','',$2,'paused',20,$3),($4,'instagram','Other account','',$5,'paused',20,'{}')",
        [
          accountId,
          actor,
          {
            storageStateEncrypted: 'enc-cookies',
            cookiesEncrypted: 'enc-legacy-cookies',
            credentialsEncrypted: 'enc-credentials',
            loginCodeEncrypted: 'enc-totp-and-code',
            ownProxyEncrypted: 'enc-proxy',
          },
          otherAccountId,
          actor,
        ],
      );
      await sonarPool.query(
        "insert into conversations(id,account_id,channel,provider_thread_id) values($1,$2,'social','thread-delete-test')",
        [conversationId, accountId],
      );
      await sonarPool.query(
        "insert into messages(id,conversation_id,account_id,direction,channel,to_value,subject,body,idempotency_key,status,first_attempt_at,request_snapshot) values($1,$2,$3,'in','social','peer','','inbound history',$4,'sent',now(),'{}'),($5,$2,$3,'out','social','peer','','attempted outbound history',$6,'sent',now(),'{}')",
        [
          inboundId,
          conversationId,
          accountId,
          randomUUID(),
          outboundId,
          randomUUID(),
        ],
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,status,payload) values($1,'social.session.login',$1::uuid::text,'queued',$6),($2,'social.session.check',$2::uuid::text,'paused',$6),($3,'social.session.keepalive',$3::uuid::text,'queued',$6),($4,'social.inbox.sync',$4::uuid::text,'queued',$6),($5,'message.send',$5::uuid::text,'paused',$7)",
        [...taskIds, { accountId }, { messageId: outboundId }],
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,status,payload) values($1,'social.session.login',$1::uuid::text,'queued',$2)",
        [foreignTask, { accountId: otherAccountId }],
      );
      await expect(
        accounts.removeSocialAccount(accountId, other),
      ).rejects.toThrow('Акаунт соцмережі не знайдено.');
      expect(
        (
          await sonarPool.query(
            'select settings from channel_accounts where id=$1',
            [accountId],
          )
        ).rows[0].settings.credentialsEncrypted,
      ).toBe('enc-credentials');

      await expect(
        accounts.removeSocialAccount(accountId, actor),
      ).resolves.toBe(true);
      expect(
        (
          await sonarPool.query('select id from channel_accounts where id=$1', [
            accountId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await sonarPool.query(
            'select account_id from conversations where id=$1',
            [conversationId],
          )
        ).rows[0].account_id,
      ).toBeNull();
      expect(
        (
          await sonarPool.query(
            'select id,account_id,body,request_snapshot from messages where id=any($1::uuid[]) order by id',
            [[inboundId, outboundId]],
          )
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: inboundId,
            account_id: null,
            body: 'inbound history',
          }),
          expect.objectContaining({
            id: outboundId,
            account_id: null,
            body: 'attempted outbound history',
            request_snapshot: {},
          }),
        ]),
      );
      expect(
        (
          await sonarPool.query(
            'select status,reason_uk,reason_code from tasks where id=any($1::uuid[])',
            [taskIds],
          )
        ).rows,
      ).toHaveLength(taskIds.length);
      expect(
        (
          await sonarPool.query(
            'select status,reason_uk,reason_code from tasks where id=any($1::uuid[])',
            [taskIds],
          )
        ).rows,
      ).toEqual(
        expect.arrayContaining(
          taskIds.map(() =>
            expect.objectContaining({
              status: 'skipped',
              reason_uk: 'Акаунт видалено.',
              reason_code: 'social_account_deleted',
            }),
          ),
        ),
      );
      expect(
        (
          await sonarPool.query('select status from tasks where id=$1', [
            foreignTask,
          ])
        ).rows[0].status,
      ).toBe('queued');
      expect(
        (
          await sonarPool.query(
            "select user_id,action from activity_log where entity_id=$1 and action='social.account.removed'",
            [accountId],
          )
        ).rows[0],
      ).toEqual({ user_id: actor, action: 'social.account.removed' });
    } finally {
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        accountId,
      ]);
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        [...taskIds, foreignTask],
      ]);
      await sonarPool.query('delete from messages where id=any($1::uuid[])', [
        [inboundId, outboundId],
      ]);
      await sonarPool.query('delete from conversations where id=$1', [
        conversationId,
      ]);
      await sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [[accountId, otherAccountId]],
      );
      await sonarPool.query('delete from users where id=any($1::uuid[])', [
        [actor, other],
      ]);
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
    }
  },
);

it.skipIf(!enabled)(
  'reserves session reading separately from sends, shares the account lock and falls back after its daily limit or session pause',
  async () => {
    const { sonarPool } = await import('./index.js');
    const accounts = await import('./social-accounts.js');
    const actor = randomUUID(),
      requestId = randomUUID(),
      request2 = randomUUID();
    const oldSecret = process.env.AUTH_SECRET,
      oldProxies = process.env.SOCIAL_PROXY_URLS;
    process.env.AUTH_SECRET = 'social-fetch-integration-secret-at-least-32';
    process.env.SOCIAL_PROXY_URLS = 'http://pinned.example:8000';
    const c = await sonarPool.connect(),
      sender = await sonarPool.connect();
    let accountId: string | undefined;
    const now = new Date('2026-11-13T10:00:00Z');
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Fetch account test','unused')",
        [actor, `${actor}@example.test`],
      );
      const saved = await accounts.saveSocialAccount(
        {
          network: 'instagram',
          name: 'Session fetch integration',
          dailyLimit: 1,
          proxyIndex: 0,
          cookiesJson: JSON.stringify([
            {
              name: 'session',
              value: 'private-cookie',
              domain: '.instagram.com',
              session: true,
            },
          ]),
        },
        actor,
      );
      accountId = saved.id;
      await accounts.withSocialSessionCheck(
        saved.id,
        async () => ({ valid: true }),
        new Date(now.getTime() - 120000),
      );
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,payload,status) values($1::uuid,'social.request',$1::text,'{}','running'),($2::uuid,'social.request',$2::text,'{}','running')",
        [requestId, request2],
      );
      // Sends hold this exact lock for their provider call. Reads defer rather than sharing a session concurrently.
      await sender.query(
        "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
        [saved.id],
      );
      expect(
        await accounts.acquireSocialFetchSession(c, 'instagram', 1, now),
      ).toMatchObject({ runAt: expect.any(Date) });
      await sender.query(
        "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
        [saved.id],
      );
      const selected = await accounts.acquireSocialFetchSession(
        c,
        'instagram',
        1,
        now,
      );
      expect(selected).toMatchObject({
        account: { id: saved.id },
        session: { proxy: { server: 'http://pinned.example:8000' } },
      });
      expect(
        (
          await sender.query(
            "select pg_try_advisory_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
            [saved.id],
          )
        ).rows[0].locked,
      ).toBe(false);
      await accounts.reserveSocialFetchSession(c, saved.id, requestId, 90, now);
      await accounts.reserveSocialFetchSession(c, saved.id, requestId, 90, now);
      await accounts.releaseSocialFetchSession(c, saved.id);
      const stored = (
        await sonarPool.query(
          'select settings,next_send_at from channel_accounts where id=$1',
          [saved.id],
        )
      ).rows[0];
      expect(stored.settings.sessionFetch).toEqual({
        day: '2026-11-13',
        count: 1,
        nextAt: '2026-11-13T10:01:30.000Z',
      });
      expect(stored.next_send_at).toBeNull();
      expect(
        await accounts.acquireSocialFetchSession(c, 'instagram', 1, now),
      ).toBeNull();
      expect(
        await accounts.acquireSocialFetchSession(c, 'instagram', 2, now),
      ).toEqual({ runAt: new Date('2026-11-13T10:02:00Z') });
      const tomorrow = new Date('2026-11-14T00:00:00Z');
      expect(
        await accounts.acquireSocialFetchSession(c, 'instagram', 1, tomorrow),
      ).toHaveProperty('account');
      await accounts.reserveSocialFetchSession(
        c,
        saved.id,
        request2,
        90,
        tomorrow,
      );
      await accounts.pauseSocialFetchSession(c, saved.id);
      await accounts.releaseSocialFetchSession(c, saved.id);
      expect(
        await accounts.acquireSocialFetchSession(c, 'instagram', 2, tomorrow),
      ).toBeNull();
      const paused = (
        await sonarPool.query(
          'select status,settings from channel_accounts where id=$1',
          [saved.id],
        )
      ).rows[0];
      expect(paused).toMatchObject({
        status: 'paused',
        settings: {
          sessionStatus: 'invalid',
          sessionFetch: { day: '2026-11-14', count: 1 },
          reasonUk: socialSessionCheckReasons.login_required,
        },
      });
      expect(
        await accounts.acquireSocialFetchSession(c, 'facebook', 60, now),
      ).toBeNull();
    } finally {
      if (accountId) {
        await c.query('select pg_advisory_unlock_all()');
        await sender.query('select pg_advisory_unlock_all()');
      }
      c.release();
      sender.release();
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        [requestId, request2],
      ]);
      await sonarPool.query('delete from activity_log where user_id=$1', [
        actor,
      ]);
      if (accountId)
        await sonarPool.query('delete from channel_accounts where id=$1', [
          accountId,
        ]);
      await sonarPool.query('delete from users where id=$1', [actor]);
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
    }
  },
);
