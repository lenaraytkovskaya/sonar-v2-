import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'SQL company filters, escaped text/phone search, campaign scope and pagination',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { listCompanies, getCompany, exportCompanies } =
      await import('./companies.js');
    const { createBatch } = await import('./batches.js');
    const prefix = randomUUID();
    let campaignId: string | undefined;
    const ids: string[] = [];
    try {
      const {
        rows: [campaign],
      } = await sonarPool.query(
        `insert into campaigns(name,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,scoring_weights) values($1,'UA','uk',ARRAY['Київ'],ARRAY['СТО'],'',20,.5,'{}','{}') returning id`,
        [prefix],
      );
      campaignId = campaign.id;
      const batch = await createBatch(
        campaign.id,
        null,
        randomUUID(),
        false,
        false,
      );
      for (let i = 0; i < 27; i++) {
        const {
          rows: [company],
        } = await sonarPool.query(
          `insert into companies(place_id,name,city,rating,website,domain,status) values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [
            prefix + i,
            i === 0 ? '100%_ Авто' : `Авто ${i}`,
            i % 2 ? 'Львів' : 'Київ',
            i % 2 ? 4 : 4.8,
            i % 2 ? null : 'https://example.test',
            'example.test',
            i % 2 ? 'new' : 'ready',
          ],
        );
        ids.push(company.id);
        await sonarPool.query(
          'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3)',
          [campaign.id, company.id, batch.id],
        );
        if (i % 2 === 0)
          await sonarPool.query(
            "insert into contacts(company_id,kind,value,normalized,source) values($1,'phone','044 222 33 44','+380442223344','google')",
            [company.id],
          );
      }
      expect((await listCompanies({ campaignId }, 1)).companies).toHaveLength(
        25,
      );
      expect((await listCompanies({ campaignId }, 2)).companies).toHaveLength(
        2,
      );
      const filtered = await listCompanies({
        campaignId,
        city: 'Київ',
        status: 'ready',
        hasWebsite: true,
        hasPhone: true,
        minRating: 4.5,
      });
      expect(filtered.total).toBe(14);
      expect(
        (
          await listCompanies({
            campaignId,
            hasPhone: false,
            hasWebsite: false,
          })
        ).total,
      ).toBe(13);
      expect((await listCompanies({ campaignId, q: '100%_' })).total).toBe(1);
      expect(
        (await listCompanies({ campaignId, q: 'example.test' })).total,
      ).toBe(27);
      expect(
        (await listCompanies({ campaignId, q: '044 222 33 44' })).total,
      ).toBe(14);
      expect(
        (await listCompanies({ campaignId, q: "' OR 1=1 --" })).total,
      ).toBe(0);
      expect((await getCompany(ids[0]!))?.campaigns).toHaveLength(1);
      const exported = [];
      for await (const row of exportCompanies({ campaignId }))
        exported.push(row.id);
      expect(exported).toHaveLength(27);
      expect(new Set(exported).size).toBe(27);
      const interrupted = exportCompanies({ campaignId });
      await interrupted.next();
      await interrupted.return();
    } finally {
      await sonarPool.query(
        'delete from contacts where company_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query(
        'delete from campaign_companies where campaign_id=$1',
        [campaignId],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        campaignId,
      ]);
      await sonarPool.query('delete from batches where campaign_id=$1', [
        campaignId,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaignId]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
