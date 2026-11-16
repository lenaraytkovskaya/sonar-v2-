import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { decryptTelegramSession } from '@sonar/core/telegram';
import {
  encryptSocialCookies,
  socialProxyFingerprint,
  SocialSessionCheckError,
} from '@sonar/core/social-session';

it.skipIf(process.env.RUN_DB_TESTS !== '1')(
  'persists full browser state and device under one lock, migrates cookies, deduplicates session loss and keeps own proxy private',
  async () => {
    const { sonarPool } = await import('./index.js');
    const accounts = await import('./social-accounts.js');
    const actor = randomUUID();
    const ids: string[] = [];
    const oldSecret = process.env.AUTH_SECRET;
    const oldProxies = process.env.SOCIAL_PROXY_URLS;
    const secret = 'durable-session-secret-longer-than-32-characters';
    process.env.AUTH_SECRET = secret;
    process.env.SOCIAL_PROXY_URLS =
      'http://meta.invalid:8000,http://linkedin.invalid:8000,http://extra.invalid:8000';
    const cookie = {
      name: 'sid',
      value: 'private-cookie',
      domain: '.facebook.com',
      session: true,
    };
    const state = {
      cookies: [cookie],
      origins: [
        {
          origin: 'https://www.facebook.com',
          localStorage: [{ name: 'token', value: 'private-local-value' }],
        },
      ],
    };
    let time = Date.parse('2026-11-20T00:00:00Z');
    const check = (
      id: string,
      callback: Parameters<typeof accounts.withSocialSessionCheck>[1],
    ) =>
      accounts.withSocialSessionCheck(id, callback, new Date((time += 180000)));
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Durable session test','unused')",
        [actor, `${actor}@example.test`],
      );
      const saved = await accounts.saveSocialAccount(
        {
          network: 'facebook',
          name: 'Own proxy',
          dailyLimit: 20,
          storageStateJson: JSON.stringify(state),
          ownProxy: 'http://own:private-password@extra.invalid:8000',
        },
        actor,
      );
      ids.push(saved.id);
      const read = async () =>
        (
          await sonarPool.query(
            'select settings,status from channel_accounts where id=$1',
            [saved.id],
          )
        ).rows[0];
      expect((await read()).settings.storageStateEncrypted).not.toContain(
        'private',
      );
      await check(saved.id, async (_account, session) => {
        expect(session.storageState.origins).toEqual(state.origins);
        await session.persistDevice({
          ...session.device,
          userAgent: 'Pinned desktop UA',
        });
        await session.persistStorageState({
          ...session.storageState,
          origins: [
            {
              ...state.origins[0]!,
              localStorage: [{ name: 'token', value: 'refreshed' }],
            },
          ],
        });
        await expect(
          session.persistStorageState({ cookies: [], origins: [] }),
        ).rejects.toThrow();
        return { valid: true };
      });
      const stored = await read();
      expect(stored.settings.device.userAgent).toBe('Pinned desktop UA');
      expect(
        JSON.parse(
          decryptTelegramSession(stored.settings.storageStateEncrypted, secret),
        ).origins[0].localStorage[0].value,
      ).toBe('refreshed');
      // Editing nonproxy fields preserves an own proxy when no common pool exists.
      process.env.SOCIAL_PROXY_URLS = '';
      await accounts.saveSocialAccount(
        {
          id: saved.id,
          network: 'facebook',
          name: 'Renamed',
          dailyLimit: 15,
          keepaliveEnabled: false,
        },
        actor,
      );
      expect((await read()).settings).toMatchObject({
        ownProxyEncrypted: stored.settings.ownProxyEncrypted,
        sessionStatus: 'valid',
        device: stored.settings.device,
      });
      process.env.SOCIAL_PROXY_URLS =
        oldProxies ??
        'http://meta.invalid:8000,http://linkedin.invalid:8000,http://extra.invalid:8000';
      await check(saved.id, async () => ({
        valid: false,
        reason: 'checkpoint',
      }));
      const firstEvent = (await read()).settings.sessionLostEventId;
      await check(saved.id, async () => ({ valid: false, reason: 'network' }));
      await check(saved.id, async () => ({
        valid: false,
        reason: 'login_required',
      }));
      expect((await read()).settings.sessionLostEventId).toBe(firstEvent);
      expect(await accounts.listSocialSessionNotices(actor)).toMatchObject([
        { eventId: firstEvent },
      ]);
      await check(saved.id, async () => ({ valid: true }));
      expect(await accounts.listSocialSessionNotices(actor)).toEqual([]);
      await check(saved.id, async () => {
        throw new SocialSessionCheckError('checkpoint');
      });
      expect((await read()).settings.sessionLostEventId).not.toBe(firstEvent);
      expect(
        JSON.stringify(
          (await accounts.listSocialAccounts(actor)).find(
            (a) => a.id === saved.id,
          ),
        ),
      ).not.toMatch(
        /private-password|private-cookie|storageStateEncrypted|ownProxyEncrypted/,
      );
      expect(await accounts.getSocialReservedProxyEndpoints()).toContainEqual({
        server: 'http://extra.invalid:8000',
        username: 'own',
        password: 'private-password',
      });
      // A queued keepalive cannot reopen a paused or disabled account.
      const stale = vi.fn(async () => ({ valid: true }));
      expect(
        await accounts.withSocialSessionCheck(
          saved.id,
          stale,
          new Date((time += 180000)),
          'keepalive',
        ),
      ).toMatchObject({ status: 'skipped' });
      expect(stale).not.toHaveBeenCalled();
      // Legacy cookie-only state gains full encrypted state and stable device in one locked use.
      const legacy = randomUUID();
      ids.push(legacy);
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,settings) values($1,'facebook','Legacy','',$2,'active',20,$3)",
        [
          legacy,
          actor,
          {
            cookiesEncrypted: encryptSocialCookies(
              JSON.stringify([cookie]),
              'facebook',
              secret,
            ),
            sessionStatus: 'valid',
            proxyIndex: 0,
            proxyFingerprint: socialProxyFingerprint({
              server: 'http://meta.invalid:8000',
            }),
          },
        ],
      );
      process.env.SOCIAL_PROXY_URLS =
        'http://meta.invalid:8000,http://linkedin.invalid:8000,http://extra.invalid:8000';
      await check(legacy, async (_account, session) => {
        expect(session.storageState.cookies).toHaveLength(1);
        return { valid: true };
      });
      const migrated = (
        await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [legacy],
        )
      ).rows[0].settings;
      expect(migrated.cookiesEncrypted).toBeUndefined();
      expect(migrated.storageStateEncrypted).toBeTypeOf('string');
      expect(migrated.device).toBeDefined();
      // Transport/browser failures retain verified auth and retry the same maintenance job.
      time = Date.parse(migrated.nextKeepaliveAt);
      for (const reason of ['network', 'timeout', 'browser'] as const) {
        const failed = await accounts.withSocialSessionCheck(
          legacy,
          async () => {
            throw new SocialSessionCheckError(reason);
          },
          new Date(time),
          'keepalive',
        );
        expect(failed).toMatchObject({
          status: 'deferred',
          reasonCode: `social_keepalive_${reason}`,
        });
        if (failed.status !== 'deferred')
          throw new Error('Expected keepalive retry');
        expect(failed.runAt.getTime()).toBeGreaterThan(time);
        const retained = (
          await sonarPool.query(
            'select status,settings from channel_accounts where id=$1',
            [legacy],
          )
        ).rows[0];
        expect(retained).toMatchObject({
          status: 'active',
          settings: {
            sessionStatus: 'valid',
            lastKeepaliveReason: reason,
            nextKeepaliveAt: failed.runAt.toISOString(),
          },
        });
        expect(retained.settings.sessionLostEventId).toBeUndefined();
        const early = vi.fn(async () => ({ valid: true }));
        expect(
          await accounts.withSocialSessionCheck(
            legacy,
            early,
            new Date(failed.runAt.getTime() - 1),
            'keepalive',
          ),
        ).toMatchObject({
          status: 'deferred',
          reasonCode: 'social_keepalive_scheduled',
        });
        expect(early).not.toHaveBeenCalled();
        time = failed.runAt.getTime();
      }
      expect(
        await accounts.withSocialSessionCheck(
          legacy,
          async () => ({ valid: true }),
          new Date(time),
          'keepalive',
        ),
      ).toMatchObject({ status: 'done' });
      const recovered = (
        await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [legacy],
        )
      ).rows[0].settings;
      expect(recovered.lastKeepaliveReason).toBeNull();
      expect(Date.parse(recovered.nextKeepaliveAt)).toBeGreaterThan(time);

      const totalLimit = (
        await sonarPool.query(
          "select value from settings where key='social.action.daily_limit'",
        )
      ).rows[0].value;
      await sonarPool.query(
        'update channel_accounts set settings=settings||$2::jsonb where id=$1',
        [
          legacy,
          {
            socialAction: {
              day: new Date(time + 180000).toISOString().slice(0, 10),
              counts: { send: totalLimit - 1, sync: 1 },
            },
          },
        ],
      );
      const exhausted = vi.fn(async () => ({ valid: true }));
      expect(await check(legacy, exhausted)).toMatchObject({
        status: 'deferred',
        reasonCode: 'social_action_gate',
      });
      expect(exhausted).not.toHaveBeenCalled();
      const c = await sonarPool.connect();
      try {
        expect(
          await accounts.acquireSocialFetchSession(
            c,
            'facebook',
            100,
            new Date(time),
          ),
        ).toMatchObject({ runAt: expect.any(Date) });
      } finally {
        c.release();
      }
      const linkedin = randomUUID();
      ids.push(linkedin);
      await sonarPool.query(
        "insert into channel_accounts(id,channel,name,address,owner_id,status,daily_limit,settings) values($1,'linkedin','LinkedIn migration','',$2,'active',20,$3)",
        [
          linkedin,
          actor,
          {
            cookiesEncrypted: encryptSocialCookies(
              JSON.stringify([{ ...cookie, domain: '.linkedin.com' }]),
              'linkedin',
              secret,
            ),
            sessionStatus: 'valid',
            proxyIndex: 1,
            proxyFingerprintPending: true,
          },
        ],
      );
      await check(linkedin, async (_account, session) => {
        expect(session.proxy.server).toBe('http://linkedin.invalid:8000');
        return { valid: true };
      });
      const linkedSettings = (
        await sonarPool.query(
          'select settings from channel_accounts where id=$1',
          [linkedin],
        )
      ).rows[0].settings;
      expect(linkedSettings.proxyFingerprint).toBe(
        socialProxyFingerprint({ server: 'http://linkedin.invalid:8000' }),
      );
      expect(linkedSettings.proxyFingerprintPending).toBeUndefined();
    } finally {
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
      await sonarPool.query(
        "delete from tasks where payload->>'accountId'=any($1::text[])",
        [ids],
      );
      await sonarPool.query('delete from activity_log where user_id=$1', [
        actor,
      ]);
      await sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query('delete from users where id=$1', [actor]);
    }
  },
);
