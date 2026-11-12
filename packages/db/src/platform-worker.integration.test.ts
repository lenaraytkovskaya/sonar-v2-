import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'platform scans skip social/maps, preserve provenance and enforce public crawl limits',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runSiteScan } = await import('../../../apps/worker/src/site.js');
    const { SiteHttp } = await import('../../../apps/worker/src/site-http.js');
    const companyIds: string[] = [];
    const taskIds: string[] = [];
    const create = async (website: string) => {
      const {
        rows: [company],
      } = await sonarPool.query(
        "insert into companies(place_id,name,website,country_code) values($1,'Platform integration',$2,'UA') returning id",
        [randomUUID(), website],
      );
      companyIds.push(company.id);
      const {
        rows: [task],
      } = await sonarPool.query(
        "insert into tasks(type,idempotency_key,payload,subject_type,subject_id) values('site.scan',$1,$2,'company',$3) returning id",
        [randomUUID(), JSON.stringify({ companyId: company.id }), company.id],
      );
      taskIds.push(task.id);
      return { companyId: company.id as string, taskId: task.id as string };
    };
    const socialUrl = `https://facebook.com/platform_${randomUUID()}`;
    const classifiedUrl = 'https://olx.ua/ad/public-seller';
    const seller = 'Петренко Іван Петрович';
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      seller: {
        '@type': 'Person',
        name: seller,
        url: '/seller/public',
        sameAs: 'https://independent-seller.test/',
        address: { addressLocality: 'Київ' },
      },
    })}</script><p>ФОП ${seller}</p><a href="tel:+380673142758">Call</a><a href="/contact">Contact</a>`;
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const read = vi
      .spyOn(SiteHttp.prototype, 'read')
      .mockImplementation(async (url) => ({
        url,
        status: url.includes('/forbidden')
          ? 403
          : url.endsWith('/sitemap.xml')
            ? 404
            : 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(
          url.includes('/captcha')
            ? '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test.js"></script>'
            : url === classifiedUrl
              ? listing
              : '<p>Public minisite content</p><a href="/contact">Contact</a><a href="/about">About</a><a href="/news">News</a><a href="/legal">Legal</a>',
        ),
      }));
    try {
      const social = await create(socialUrl);
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          await runSiteScan({ companyId: social.companyId }, social.taskId),
        ).toMatchObject({
          status: 'skipped',
          reasonCode: 'platform_social',
          reasonUk: 'Сайт компанії — сторінка соцмережі',
        });
      const { rows: contacts } = await sonarPool.query(
        'select * from contacts where company_id=$1',
        [social.companyId],
      );
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        kind: 'social',
        value: socialUrl,
        normalized: socialUrl,
        source: 'website',
        source_url: socialUrl,
      });
      expect(contacts[0].found_at).toBeInstanceOf(Date);
      const maps = await create('https://google.com/maps?cid=stub');
      expect(
        await runSiteScan({ companyId: maps.companyId }, maps.taskId),
      ).toMatchObject({
        status: 'skipped',
        reasonCode: 'platform_maps',
        reasonUk: 'Сайт компанії — сторінка карт або каталогу',
      });
      expect(
        (
          await sonarPool.query('select * from contacts where company_id=$1', [
            maps.companyId,
          ])
        ).rows,
      ).toEqual([]);
      expect(read).not.toHaveBeenCalled();
      for (const [path, reasonCode] of [
        ['forbidden', 'http_403'],
        ['captcha', 'challenge'],
      ]) {
        const blocked = await create(`https://olx.ua/${path}`);
        expect(
          await runSiteScan({ companyId: blocked.companyId }, blocked.taskId),
        ).toMatchObject({
          status: 'skipped',
          reasonCode,
          reasonUk: 'Площадка не дозволяє автоматичне читання сторінки',
        });
        const { rows: facts } = await sonarPool.query(
          "select * from company_facts where company_id=$1 and kind='site_status'",
          [blocked.companyId],
        );
        expect(facts[0]).toMatchObject({
          source_url: `https://olx.ua/${path}`,
          value: {
            status: 'unavailable',
            pages: 0,
            reason: 'Площадка не дозволяє автоматичне читання сторінки',
          },
        });
      }
      read.mockClear();
      const classified = await create(classifiedUrl);
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          await runSiteScan(
            { companyId: classified.companyId },
            classified.taskId,
          ),
        ).toMatchObject({
          status: 'done',
          result: { pages: 1, aiUsed: false, costUsd: 0 },
        });
      expect(read.mock.calls.map(([url]) => url)).toEqual([
        classifiedUrl,
        classifiedUrl,
      ]);
      const { rows: facts } = await sonarPool.query(
        'select * from company_facts where company_id=$1',
        [classified.companyId],
      );
      for (const [kind, value] of [
        ['platform_seller', seller],
        ['platform_profile', 'https://olx.ua/seller/public'],
        ['platform_city', 'Київ'],
        ['website_candidate', 'https://independent-seller.test/'],
        ['fop_name', seller],
      ]) {
        const matching = facts.filter((fact) => fact.kind === kind);
        expect(matching).toHaveLength(1);
        expect(matching[0]).toMatchObject({
          value,
          source: 'website',
          source_url: classifiedUrl,
        });
        expect(matching[0].found_at).toBeInstanceOf(Date);
      }
      read.mockClear();
      const minisite = await create('https://taplink.cc/public-seller');
      expect(
        await runSiteScan({ companyId: minisite.companyId }, minisite.taskId),
      ).toMatchObject({
        status: 'done',
        result: { pages: 3, aiUsed: false, costUsd: 0 },
      });
      expect(
        read.mock.calls.filter(([url]) => !url.endsWith('/sitemap.xml')),
      ).toHaveLength(3);
      expect(
        (
          await sonarPool.query(
            'select * from spend_events where task_id=any($1::uuid[])',
            [taskIds],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      read.mockRestore();
      vi.unstubAllEnvs();
      for (const table of ['company_facts', 'contacts'])
        await sonarPool.query(
          `delete from ${table} where company_id=any($1::uuid[])`,
          [companyIds],
        );
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [companyIds],
      );
      await sonarPool.query('delete from tasks where id=any($1::uuid[])', [
        taskIds,
      ]);
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        companyIds,
      ]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
