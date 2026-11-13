import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'deduplicates a shared profile globally, fans out provenance, caches billing and pauses paid protection failures',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { enqueueCompanySocial, getCompanySocial, saveSocialProfile } =
      await import('./social.js');
    const { runSocialFetch } =
      await import('../../../apps/worker/src/social.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('social.fetch');
    const companyIds = [randomUUID(), randomUUID()];
    const handle = `sonar${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const url = `https://www.instagram.com/${handle}/`;
    const {
      rows: [user],
    } = await sonarPool.query(
      "insert into users(email,name,password_hash) values($1,'Social test','unused') returning id",
      [`${handle}@example.test`],
    );
    const { rows: settings } = await sonarPool.query(
      "select key,value from settings where key like 'social.%' or key='budget.monthly_usd'",
    );
    const originalProxy = process.env.SOCIAL_PROXY_URLS;
    const fetch = vi.fn(async () => ({
      html: `<html><meta property="og:url" content="${url}"><meta property="og:title" content="Sonar public company"><meta property="og:description" content="Company profile"></html>`,
      url,
      status: 200,
    }));
    try {
      await sonarPool.query(
        "update settings set value='{}' where key='social.instagram.runtime'",
      );
      await sonarPool.query(
        "update settings set value='0' where key='social.instagram.min_gap_seconds'",
      );
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','100') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        "update settings set value='false' where key='social.enabled'",
      );
      for (const id of companyIds) {
        await sonarPool.query(
          "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::uuid::text,'Social integration','UA')",
          [id],
        );
        await sonarPool.query(
          "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'website')",
          [id, url],
        );
      }
      expect(await enqueueCompanySocial(companyIds[0]!, null)).toEqual({
        tasks: [],
        disabled: true,
      });
      const first = await enqueueCompanySocial(companyIds[0]!, user.id);
      const second = await enqueueCompanySocial(companyIds[1]!, user.id);
      expect(first.tasks[0]?.created).toBe(true);
      expect(second.tasks[0]?.id).toBe(first.tasks[0]?.id);
      expect(second.tasks[0]?.created).toBe(false);
      const taskId = first.tasks[0]!.id;
      const {
        rows: [task],
      } = await sonarPool.query('select payload from tasks where id=$1', [
        taskId,
      ]);
      process.env.SOCIAL_PROXY_URLS =
        'http://reserved.example:8000,http://test:password@proxy.example:8000';
      expect(await runSocialFetch(task.payload, taskId, fetch)).toMatchObject({
        status: 'done',
      });
      expect(await runSocialFetch(task.payload, taskId, fetch)).toMatchObject({
        status: 'done',
      });
      expect(fetch).toHaveBeenCalledOnce();
      const { parseSocialProfile, socialTarget: targetFromUrl } =
        await import('@sonar/core');
      const target = targetFromUrl(url)!;
      const enriched = {
        ...parseSocialProfile('', target, 'UA'),
        name: 'Sonar public company',
        address: 'Тестова вулиця, 12',
        emails: ['social@example.test'],
        method: 'session' as const,
      };
      await saveSocialProfile(sonarPool, companyIds, target, enriched);
      for (const id of companyIds) {
        expect((await getCompanySocial(id)).profiles[0]?.profile).toMatchObject(
          {
            method: 'session',
            address: enriched.address,
            emails: enriched.emails,
          },
        );
        expect(
          (
            await sonarPool.query(
              "select kind,source,source_url from contacts where company_id=$1 and kind='address'",
              [id],
            )
          ).rows,
        ).toEqual([{ kind: 'address', source: 'instagram', source_url: url }]);
      }
      for (const id of companyIds)
        expect((await getCompanySocial(id)).profiles[0]).toMatchObject({
          network: 'instagram',
          profile: { name: 'Sonar public company' },
          sourceUrl: url,
          task: { status: 'done' },
        });
      expect(
        (
          await sonarPool.query(
            "select count(*)::int as count from spend_events s join tasks t on s.task_id=t.id where t.payload->>'parentId'=$1",
            [taskId],
          )
        ).rows[0].count,
      ).toBe(1);
      const { socialTarget } = await import('@sonar/core');
      const blockedTarget = socialTarget(
        `https://www.instagram.com/blocked${handle.slice(0, 15)}/`,
      )!;
      const blockedId = randomUUID();
      const blockedPayload = {
        companyId: companyIds[0]!,
        target: blockedTarget,
        requestVersion: 0,
        manual: false,
      };
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,payload,subject_type,subject_id) values($1,'social.fetch',$2,$3,'company',$4)",
        [
          blockedId,
          `social.fetch:instagram:${blockedTarget.handle}:${new Date().toISOString().slice(0, 10)}`,
          JSON.stringify(blockedPayload),
          companyIds[0],
        ],
      );
      const forbidden = vi.fn(async () => ({
        html: 'Forbidden',
        url: blockedTarget.canonicalUrl,
        status: 403,
      }));
      expect(
        await runSocialFetch(blockedPayload, blockedId, forbidden),
      ).toMatchObject({ status: 'skipped', reasonCode: 'social_forbidden' });
      expect(
        await runSocialFetch(blockedPayload, blockedId, forbidden),
      ).toMatchObject({ status: 'skipped' });
      expect(forbidden).toHaveBeenCalledOnce();
      expect(
        (
          await sonarPool.query(
            "select value from settings where key='social.instagram.runtime'",
          )
        ).rows[0].value,
      ).toMatchObject({ blocked: true, count: 2 });
      expect(
        Number(
          (
            await sonarPool.query(
              "select sum(s.cost_usd) as cost from spend_events s join tasks t on s.task_id=t.id where t.payload->>'parentId'=$1",
              [blockedId],
            )
          ).rows[0].cost,
        ),
      ).toBeGreaterThan(0);
      await sonarPool.query("update tasks set status='skipped' where id=$1", [
        blockedId,
      ]);
      const { retryTask } = await import('./tasks.js');
      expect(await retryTask(blockedId, user.id)).toBe(true);
      const {
        rows: [retry],
      } = await sonarPool.query('select payload from tasks where id=$1', [
        blockedId,
      ]);
      expect(retry.payload).toMatchObject({ requestVersion: 1, manual: true });
      expect(
        await runSocialFetch(retry.payload, blockedId, forbidden),
      ).toMatchObject({
        status: 'paused',
        reasonCode: 'social_network_paused',
      });
      expect(forbidden).toHaveBeenCalledOnce();
      await sonarPool.query(
        "update settings set value='{}' where key='social.instagram.runtime'",
      );
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','0') on conflict(key) do update set value=excluded.value",
      );
      const budgetResult = await runSocialFetch(
        retry.payload,
        blockedId,
        forbidden,
      );
      expect(budgetResult).toMatchObject({
        status: 'paused',
        reasonCode: 'budget_exceeded',
      });
      expect(forbidden).toHaveBeenCalledOnce();
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','0') on conflict(key) do update set value=excluded.value",
      );
      expect(
        await import('./tasks.js').then(({ retryTask }) =>
          retryTask(taskId, user.id),
        ),
      ).toBe(false);
    } finally {
      if (originalProxy === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = originalProxy;
      await sonarPool.query(
        "delete from pgboss.job where data->>'taskId' in(select id::text from tasks where subject_id=any($1::text[]))",
        [companyIds],
      );
      await sonarPool.query(
        'delete from spend_events where task_id in(select id from tasks where subject_id=any($1::text[]))',
        [companyIds],
      );
      await sonarPool.query(
        'delete from tasks where subject_id=any($1::text[])',
        [companyIds],
      );
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [companyIds],
      );
      await sonarPool.query(
        'delete from company_facts where company_id=any($1::uuid[])',
        [companyIds],
      );
      await sonarPool.query(
        'delete from contacts where company_id=any($1::uuid[])',
        [companyIds],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        companyIds,
      ]);
      await sonarPool.query('delete from users where id=$1', [user.id]);
      for (const setting of settings)
        await sonarPool.query('update settings set value=$2 where key=$1', [
          setting.key,
          JSON.stringify(setting.value),
        ]);
      if (!settings.some((setting) => setting.key === 'budget.monthly_usd'))
        await sonarPool.query(
          "delete from settings where key='budget.monthly_usd'",
        );
      await admin.stop();
    }
  },
  20000,
);
it.skipIf(!enabled)(
  'preserves session HTTP 429 as a paid network pause without a second proxy fetch or invalid cookies',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { saveSocialAccount, withSocialSessionCheck } =
      await import('./social-accounts.js');
    const { socialTarget } = await import('@sonar/core');
    const { runSocialFetch } =
      await import('../../../apps/worker/src/social.js');
    const actor = randomUUID(),
      company = randomUUID();
    const taskIds = [randomUUID(), randomUUID()];
    const target = socialTarget('https://www.instagram.com/demo.studio/')!;
    const payload = { companyId: company, target, manual: true };
    const oldSecret = process.env.AUTH_SECRET,
      oldProxies = process.env.SOCIAL_PROXY_URLS;
    const { rows: settings } = await sonarPool.query(
      "select key,value from settings where key like 'social.%' or key='budget.monthly_usd'",
    );
    process.env.AUTH_SECRET =
      'social-rate-limit-integration-secret-at-least-32';
    process.env.SOCIAL_PROXY_URLS =
      'http://pinned.example:8000,http://anonymous.example:8000';
    let accountId: string | undefined;
    try {
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Rate limit test','unused')",
        [actor, `${actor}@example.test`],
      );
      const saved = await saveSocialAccount(
        {
          network: 'instagram',
          name: 'Rate limit test',
          dailyLimit: 60,
          proxyIndex: 0,
          cookiesJson: JSON.stringify([
            {
              name: 'session',
              value: 'synthetic',
              domain: '.instagram.com',
              session: true,
            },
          ]),
        },
        actor,
      );
      accountId = saved.id;
      await withSocialSessionCheck(accountId, async () => ({ valid: true }));
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::text,'Rate limit test','UA')",
        [company],
      );
      for (const id of taskIds)
        await sonarPool.query(
          "insert into tasks(id,type,idempotency_key,payload,status,subject_type,subject_id) values($1::uuid,'social.fetch',$1::text,$2,'running','company',$3)",
          [id, JSON.stringify(payload), company],
        );
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','100') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        "update settings set value=$1 where key='social.instagram.runtime'",
        [
          JSON.stringify({
            day: new Date().toISOString().slice(0, 10),
            count: 1,
            blocked: false,
          }),
        ],
      );
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({
          url: target.canonicalUrl,
          html: 'Too many requests',
          status: 429,
          usedProxy: true,
        })
        .mockResolvedValue({
          url: target.canonicalUrl,
          status: 200,
          usedProxy: true,
          html: `<meta property="og:url" content="${target.canonicalUrl}"><meta property="og:title" content="Demo">`,
        });
      const before = Date.now();
      const limited = await runSocialFetch(payload, taskIds[0]!, fetch);
      const reasonUk =
        'Соцмережа обмежила запити (429). Повторіть вручну після паузи.';
      expect(limited).toEqual({
        status: 'paused',
        reasonCode: 'social_rate_limit',
        reasonUk,
      });
      const {
        rows: [account],
      } = await sonarPool.query(
        'select status,settings from channel_accounts where id=$1',
        [accountId],
      );
      expect(account.status).toBe('active');
      expect(account.settings).toMatchObject({
        sessionStatus: 'valid',
        sessionFetch: { count: 1 },
      });
      expect(account.settings.reasonUk).toBeNull();
      const {
        rows: [runtime],
      } = await sonarPool.query(
        "select value from settings where key='social.instagram.runtime'",
      );
      expect(runtime.value).toMatchObject({
        count: 2,
        blocked: true,
        blockCode: 'rate_limit',
        reason: reasonUk,
      });
      const pauseMinutes = Number(
        settings.find((row) => row.key === 'social.instagram.pause_minutes')!
          .value,
      );
      expect(Date.parse(runtime.value.pauseUntil)).toBeGreaterThanOrEqual(
        before + pauseMinutes * 60000,
      );
      const { rows: receipts } = await sonarPool.query(
        "select s.units,s.cost_usd,s.meta from spend_events s join tasks t on t.id=s.task_id where t.payload->>'parentId'=$1",
        [taskIds[0]],
      );
      expect(receipts).toHaveLength(1);
      expect(Number(receipts[0].units)).toBe(1);
      expect(Number(receipts[0].cost_usd)).toBe(
        Number(
          settings.find((row) => row.key === 'social.cost_per_request_usd')!
            .value,
        ),
      );
      expect(JSON.parse(receipts[0].meta.response.text)).toEqual({
        failure: 'rate_limit',
      });
      expect(await runSocialFetch(payload, taskIds[0]!, fetch)).toEqual(
        limited,
      );
      expect(await runSocialFetch(payload, taskIds[1]!, fetch)).toMatchObject({
        status: 'paused',
        reasonCode: 'social_network_paused',
        reasonUk,
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]).toEqual({
        server: 'http://pinned.example:8000',
      });
      expect(fetch.mock.calls[0]?.[4]).toMatchObject({ network: 'instagram' });
      expect(
        (
          await sonarPool.query(
            'select * from company_facts where company_id=$1',
            [company],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldProxies === undefined) delete process.env.SOCIAL_PROXY_URLS;
      else process.env.SOCIAL_PROXY_URLS = oldProxies;
      await sonarPool.query(
        'delete from spend_events where task_id in (select id from tasks where subject_id=$1)',
        [company],
      );
      await sonarPool.query('delete from tasks where subject_id=$1', [company]);
      await sonarPool.query('delete from companies where id=$1', [company]);
      if (accountId)
        await sonarPool.query('delete from channel_accounts where id=$1', [
          accountId,
        ]);
      await sonarPool.query('delete from activity_log where user_id=$1', [
        actor,
      ]);
      await sonarPool.query('delete from users where id=$1', [actor]);
      for (const setting of settings)
        await sonarPool.query('update settings set value=$2 where key=$1', [
          setting.key,
          JSON.stringify(setting.value),
        ]);
      if (!settings.some((setting) => setting.key === 'budget.monthly_usd'))
        await sonarPool.query(
          "delete from settings where key='budget.monthly_usd'",
        );
    }
  },
  20000,
);
it.skipIf(!enabled)(
  'keeps DB reservation before accounts, while paused, after stale binding and during fallback',
  async () => {
    const { sonarPool } = await import('./index.js');
    const accounts = await import('./social-accounts.js');
    const { runSocialFetch } =
      await import('../../../apps/worker/src/social.js');
    const { socialTarget } = await import('@sonar/core');
    const actor = randomUUID(),
      company = randomUUID();
    const target = socialTarget(
      `https://www.instagram.com/test${company.slice(0, 8)}/`,
    )!;
    const payload = { companyId: company, target, manual: true };
    const { rows: settings } = await sonarPool.query(
      "select key,value from settings where key like 'social.%' or key='budget.monthly_usd'",
    );
    vi.stubEnv(
      'AUTH_SECRET',
      'reservation-db-test-secret-at-least-32-characters',
    );
    vi.stubEnv(
      'SOCIAL_PROXY_URLS',
      'http://p1.example:8000,http://p2.example:8000,http://p3.example:8000,http://p4.example:8000,http://p5.example:8000,http://alias:credentials@P1.example:8000',
    );
    const page = {
      html: `<meta property="og:url" content="${target.canonicalUrl}"><meta property="og:title" content="Test company">`,
      url: target.canonicalUrl,
      status: 200,
      usedProxy: true,
    };
    const fetch = vi.fn().mockResolvedValue(page);
    let accountId: string | undefined;
    async function read() {
      const id = randomUUID();
      await sonarPool.query(
        "insert into tasks(id,type,idempotency_key,payload,subject_type,subject_id,status) values($1::uuid,'social.fetch',$1::text,$2,'company',$3,'running')",
        [id, JSON.stringify(payload), company],
      );
      expect(await runSocialFetch(payload, id, fetch)).toMatchObject({
        status: 'done',
      });
    }
    try {
      expect(await accounts.getSocialAccountProxyIndex()).toBe(0);
      await sonarPool.query(
        "insert into users(id,email,name,password_hash) values($1,$2,'Reservation test','unused')",
        [actor, `${actor}@example.test`],
      );
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::text,'Reservation test','UA')",
        [company],
      );
      await sonarPool.query(
        "insert into settings(key,value) values('budget.monthly_usd','100') on conflict(key) do update set value=excluded.value",
      );
      await sonarPool.query(
        "update settings set value='0' where key='social.instagram.min_gap_seconds'",
      );
      await sonarPool.query(
        "update settings set value='{}' where key='social.instagram.runtime'",
      );
      await read(); // No account exists, but Proxy 1 is already reserved.
      const input = {
        network: 'instagram' as const,
        name: 'Reservation test',
        dailyLimit: 20,
        proxyIndex: 0,
        cookiesJson: JSON.stringify([
          {
            name: 'session',
            value: 'synthetic',
            domain: '.instagram.com',
            session: true,
          },
        ]),
      };
      await expect(
        accounts.saveSocialAccount({ ...input, proxyIndex: 1 }, actor),
      ).rejects.toThrow('резервний проксі');
      accountId = (await accounts.saveSocialAccount(input, actor)).id;
      const {
        rows: [original],
      } = await sonarPool.query(
        'select settings from channel_accounts where id=$1',
        [accountId],
      );
      await read(); // Paused/pending account cannot release the reservation.
      await sonarPool.query(
        "update channel_accounts set status='active',settings=settings||$2::jsonb where id=$1",
        [
          accountId,
          JSON.stringify({ sessionStatus: 'valid', proxyFingerprint: 'stale' }),
        ],
      );
      await read(); // Stale binding is paused, never reassigned or used anonymously.
      expect(
        (await accounts.listSocialAccounts()).find(
          (row) => row.id === accountId,
        ),
      ).toMatchObject({ status: 'paused', proxyIndex: 0 });
      await sonarPool.query(
        'update channel_accounts set settings=$2 where id=$1',
        [accountId, original.settings],
      );
      await accounts.withSocialSessionCheck(accountId, async () => ({
        valid: true,
      }));
      fetch.mockResolvedValueOnce({ ...page, error: 'session_invalid' });
      await read(); // Session on 1, fallback on the fourth anonymous endpoint.
      expect(fetch.mock.calls.map((call) => call[1].server)).toEqual(
        [2, 3, 4, 1, 5].map((index) => `http://p${index}.example:8000`),
      );
      const {
        rows: [stored],
      } = await sonarPool.query(
        'select settings from channel_accounts where id=$1',
        [accountId],
      );
      expect(stored.settings.proxyIndex).toBe(0);
      expect(stored.settings.proxyFingerprint).toBe(
        original.settings.proxyFingerprint,
      );
    } finally {
      vi.unstubAllEnvs();
      for (const table of [
        'spend_events',
        'tasks',
        'activity_log',
        'company_facts',
        'contacts',
      ]) {
        const condition =
          table === 'spend_events'
            ? 'task_id in(select id from tasks where subject_id=$1)'
            : table === 'tasks'
              ? 'subject_id=$1'
              : table === 'activity_log'
                ? 'entity_id=$1'
                : 'company_id=$1::uuid';
        await sonarPool.query(`delete from ${table} where ${condition}`, [
          company,
        ]);
      }
      await sonarPool.query('delete from activity_log where user_id=$1', [
        actor,
      ]);
      if (accountId)
        await sonarPool.query('delete from channel_accounts where id=$1', [
          accountId,
        ]);
      await sonarPool.query('delete from companies where id=$1', [company]);
      await sonarPool.query('delete from users where id=$1', [actor]);
      for (const setting of settings)
        await sonarPool.query('update settings set value=$2 where key=$1', [
          setting.key,
          JSON.stringify(setting.value),
        ]);
      if (!settings.some((row) => row.key === 'budget.monthly_usd'))
        await sonarPool.query(
          "delete from settings where key='budget.monthly_usd'",
        );
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { closeTaskQueue } = await import('./tasks.js');
    const { sonarPool, registryPool } = await import('./index.js');
    await closeTaskQueue();
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
