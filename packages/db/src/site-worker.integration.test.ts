import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'site worker persists page provenance, expiry, progress and repeat-safe contacts including Google collisions',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { runSiteScan } = await import('../../../apps/worker/src/site.js');
    const { SiteHttp, SiteUnavailable } =
      await import('../../../apps/worker/src/site-http.js');
    const prefix = randomUUID();
    const companyIds: string[] = [];
    const taskIds: string[] = [];
    const create = async (suffix: string) => {
      const {
        rows: [company],
      } = await sonarPool.query(
        "insert into companies(place_id,name,website,country_code) values($1,'Scanner integration',$2,'UA') returning id",
        [prefix + suffix, `https://${suffix}.scanner.test/`],
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
    const mock = vi
      .spyOn(SiteHttp.prototype, 'read')
      .mockImplementation(async (url) => {
        if (url.startsWith('https://blocked.'))
          throw new SiteUnavailable(
            'robots_denied',
            'Сайт забороняє сканування (robots.txt)',
          );
        const path = new URL(url).pathname;
        const html =
          path === '/contact'
            ? '<html lang="uk"><body><p>ЄДРПОУ: 12345678</p><a href="mailto:team@scanner.test">Email</a><a href="tel:+380442223344">Phone</a><a href="https://t.me/scanner_integration">Telegram</a></body></html>'
            : '<html lang="uk"><body>Автосервіс <a href="/contact">Контакти</a></body></html>';
        return {
          url,
          status: path === '/sitemap.xml' ? 404 : 200,
          body: Buffer.from(html),
          contentType: 'text/html; charset=utf-8',
        };
      });
    try {
      const scan = await create('available');
      const contactUrl = 'https://available.scanner.test/contact';
      await sonarPool.query(
        "insert into contacts(company_id,kind,value,normalized,source,source_url) values($1,'phone','044 222 33 44','+380442223344','google','https://maps.google.com/?cid=stub')",
        [scan.companyId],
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runSiteScan(
          { companyId: scan.companyId },
          scan.taskId,
        );
        expect(result).toMatchObject({
          status: 'done',
          result: { pages: 2, contacts: 3, aiUsed: false, costUsd: 0 },
        });
        if (result.status === 'done')
          expect(
            (result.result as { durationMs: number }).durationMs,
          ).toBeGreaterThanOrEqual(0);
      }
      const { rows: contacts } = await sonarPool.query(
        'select * from contacts where company_id=$1 order by kind',
        [scan.companyId],
      );
      expect(contacts).toHaveLength(3);
      expect(
        contacts.every(
          (contact) =>
            contact.source === 'website' && contact.source_url === contactUrl,
        ),
      ).toBe(true);
      expect(
        contacts.find((contact) => contact.kind === 'phone'),
      ).toMatchObject({
        normalized: '+380442223344',
        rank: 100,
        meta: {
          previousSource: 'google',
          previousSourceUrl: 'https://maps.google.com/?cid=stub',
        },
      });
      const { rows: facts } = await sonarPool.query(
        'select * from company_facts where company_id=$1',
        [scan.companyId],
      );
      expect(facts.filter((fact) => fact.kind === 'edrpou')).toHaveLength(1);
      expect(facts.find((fact) => fact.kind === 'edrpou')).toMatchObject({
        value: '12345678',
        source: 'website',
        source_url: contactUrl,
      });
      const {
        rows: [retention],
      } = await sonarPool.query(
        "select value from settings where key='retention.website_days'",
      );
      for (const fact of facts) {
        expect(fact.found_at).toBeInstanceOf(Date);
        expect(
          Math.round(
            (fact.expires_at.getTime() - fact.found_at.getTime()) / 86400000,
          ),
        ).toBe(Number(retention.value));
      }
      expect(
        (
          await sonarPool.query('select status from companies where id=$1', [
            scan.companyId,
          ])
        ).rows[0].status,
      ).toBe('enriching');
      expect(
        (
          await sonarPool.query('select result from tasks where id=$1', [
            scan.taskId,
          ])
        ).rows[0].result,
      ).toMatchObject({ pages: 2, contacts: 3 });
      expect(
        (
          await sonarPool.query(
            "select * from activity_log where entity_id=$1 and action='site.scan.done'",
            [scan.companyId],
          )
        ).rows,
      ).toHaveLength(2);
      mock.mockResolvedValueOnce({
        url: 'https://available.scanner.test/weaker',
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(
          '<p>Телефон 044 222 33 44</p><a href="mailto:team@scanner.test">Email</a><a href="https://t.me/scanner_integration">Telegram</a>',
        ),
      });
      await runSiteScan({ companyId: scan.companyId }, scan.taskId);
      const {
        rows: [ranked],
      } = await sonarPool.query(
        "select source_url,rank from contacts where company_id=$1 and kind='phone'",
        [scan.companyId],
      );
      expect(ranked).toMatchObject({ source_url: contactUrl, rank: 100 });
      const blocked = await create('blocked');
      expect(
        await runSiteScan({ companyId: blocked.companyId }, blocked.taskId),
      ).toMatchObject({
        status: 'skipped',
        reasonCode: 'robots_denied',
        reasonUk: 'Сайт забороняє сканування (robots.txt)',
      });
      const {
        rows: [status],
      } = await sonarPool.query(
        "select * from company_facts where company_id=$1 and kind='site_status'",
        [blocked.companyId],
      );
      expect(status).toMatchObject({
        source: 'website',
        source_url: 'https://blocked.scanner.test/',
        value: {
          status: 'unavailable',
          pages: 0,
          reason: 'Сайт забороняє сканування (robots.txt)',
        },
      });
      const {
        rows: [blockedTask],
      } = await sonarPool.query('select result from tasks where id=$1', [
        blocked.taskId,
      ]);
      expect(blockedTask.result).toMatchObject({
        pages: 0,
        contacts: 0,
        aiUsed: false,
        costUsd: 0,
      });
      expect(blockedTask.result.durationMs).toBeGreaterThanOrEqual(0);
      expect(
        (
          await sonarPool.query('select * from contacts where company_id=$1', [
            blocked.companyId,
          ])
        ).rows,
      ).toEqual([]);
      expect(mock).toHaveBeenCalledTimes(8);
    } finally {
      mock.mockRestore();
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
