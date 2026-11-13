import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'deduplicates a shared profile globally, fans out provenance, caches billing and pauses paid protection failures',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { enqueueCompanySocial, getCompanySocial } =
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
      process.env.SOCIAL_PROXY_URLS = 'http://test:password@proxy.example:8000';
      expect(await runSocialFetch(task.payload, taskId, fetch)).toMatchObject({
        status: 'done',
      });
      expect(await runSocialFetch(task.payload, taskId, fetch)).toMatchObject({
        status: 'done',
      });
      expect(fetch).toHaveBeenCalledOnce();
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
afterAll(async () => {
  if (enabled) {
    const { closeTaskQueue } = await import('./tasks.js');
    const { sonarPool, registryPool } = await import('./index.js');
    await closeTaskQueue();
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
