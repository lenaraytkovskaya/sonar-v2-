import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { socialSessionCheckReasons } from '@sonar/core/social-session';
const enabled = process.env.RUN_DB_TESTS === '1';
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
        expect(stored.settings.cookiesEncrypted).not.toContain(
          'private-social-cookie',
        );
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
        if (network === 'linkedin') {
          const diagnostic = {
            version: 1,
            stage: 'auth',
            urlKind: 'feed',
            navigationHttpStatus: 200,
            errorKind: 'timeout',
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
              sessionStatus: ['login_required', 'cookies_invalid'].includes(
                reason,
              )
                ? 'invalid'
                : 'unconfirmed',
              sessionCheckReason: reason,
              reasonUk: socialSessionCheckReasons[reason],
            });
            expect(
              (
                await sonarPool.query(
                  'select settings from channel_accounts where id=$1',
                  [saved.id],
                )
              ).rows[0].settings.cookiesEncrypted,
            ).toBe(stored.settings.cookiesEncrypted);
            await expect(
              accounts.updateSocialAccount(saved.id, { enabled: true }, actor),
            ).rejects.toThrow('Спочатку перевірте сесію');
          }
          const unsafe = await checkSession(saved.id, async () => {
            throw Error('https://user:secret@proxy.test/?cookies=secret');
          });
          expect(unsafe).toMatchObject({
            reasonUk: socialSessionCheckReasons.unknown_auth,
            result: { valid: false },
          });
          expect(
            JSON.stringify(
              (await accounts.listSocialAccounts()).find(
                (row) => row.id === saved.id,
              ),
            ),
          ).not.toContain('secret');
          await checkSession(saved.id, check);
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
          reasonUk: 'Увійдіть знову (оновіть cookies)',
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
