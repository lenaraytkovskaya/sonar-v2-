import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
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
        expect(
          await accounts.withSocialSessionCheck(saved.id, check),
        ).toMatchObject({ status: 'done' });
        expect(check).toHaveBeenCalledOnce();
        await accounts.updateSocialAccount(
          saved.id,
          { enabled: false, dailyLimit: 5 },
          actor,
        );
        await accounts.withSocialSessionCheck(saved.id, check);
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
        expect(
          await accounts.withSocialSessionCheck(saved.id, check),
        ).toMatchObject({ status: 'paused' });
        expect(check).not.toHaveBeenCalled();
        expect(
          (await accounts.listSocialAccounts()).find(
            (row) => row.id === saved.id,
          ),
        ).toMatchObject({ status: 'paused', sessionStatus: 'invalid' });
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
