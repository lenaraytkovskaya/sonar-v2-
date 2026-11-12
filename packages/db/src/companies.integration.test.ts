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
    let otherCampaignId: string | undefined;
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
          `insert into companies(place_id,name,city,rating,website,domain,status,created_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [
            prefix + i,
            i === 0 ? '100%_ Авто' : `Авто ${i}`,
            i % 2 ? 'Львів' : 'Київ',
            i % 2 ? 4 : 4.8,
            i % 2 ? null : 'https://example.test',
            `${prefix}.example.test`,
            i % 2 ? 'new' : 'ready',
            new Date(Date.UTC(2020, 0, 1, 0, 0, i === 2 ? 1 : i)),
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
      const {
        rows: [otherCampaign],
      } = await sonarPool.query(
        `insert into campaigns(name,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,scoring_weights) select $1,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,scoring_weights from campaigns where id=$2 returning id`,
        [`${prefix}-other`, campaignId],
      );
      otherCampaignId = otherCampaign.id;
      const otherBatch = await createBatch(
        otherCampaign.id,
        null,
        randomUUID(),
        false,
        false,
      );
      await sonarPool.query(
        'insert into campaign_companies(campaign_id,company_id,batch_id) select $1,id,$2 from companies where id=any($3::uuid[])',
        [otherCampaignId, otherBatch.id, ids.slice(0, 2)],
      );
      await sonarPool.query(
        `insert into company_scores(company_id,campaign_id,score,breakdown) values ($1,$5,10,'{}'),($2,$5,90,'{}'),($3,$5,90,'{}'),($4,$5,0,'{}'),($1,$6,99,'{}'),($2,$6,1,'{}')`,
        [...ids.slice(0, 4), campaignId, otherCampaignId],
      );
      const tied = ids.slice(1, 3).sort();
      const ranked = await listCompanies({ campaignId }, 1, 100);
      expect(ranked.companies.slice(0, 4).map((row) => row.id)).toEqual([
        ...tied,
        ids[0],
        ids[3],
      ]);
      expect(ranked.companies.slice(0, 4).map((row) => row.score)).toEqual([
        90, 90, 10, 0,
      ]);
      expect(ranked.companies.slice(4).every((row) => row.score === null)).toBe(
        true,
      );
      const page1 = await listCompanies({ campaignId }, 1, 2);
      const page2 = await listCompanies({ campaignId }, 2, 2);
      expect(
        [...page1.companies, ...page2.companies].map((row) => row.id),
      ).toEqual(ranked.companies.slice(0, 4).map((row) => row.id));
      expect((await listCompanies({ campaignId, minScore: 50 })).total).toBe(2);
      expect((await listCompanies({ campaignId, minScore: 0 })).total).toBe(4);
      expect((await listCompanies({ campaignId, minScore: 95 })).total).toBe(0);
      expect(
        (await listCompanies({ campaignId, sort: 'newest' })).companies[0]?.id,
      ).toBe(ids[26]);
      const otherRanked = await listCompanies({ campaignId: otherCampaignId });
      expect(otherRanked.companies.map((row) => [row.id, row.score])).toEqual([
        [ids[0], 99],
        [ids[1], 1],
      ]);
      const globalRanked = await listCompanies({ q: prefix, sort: 'score' });
      expect(globalRanked.total).toBe(27);
      expect(globalRanked.companies[0]).toMatchObject({
        id: ids[0],
        score: 99,
      });
      expect((await listCompanies({ q: prefix, minScore: 95 })).total).toBe(1);
      expect((await listCompanies({ q: prefix })).companies[0]?.id).toBe(
        ids[26],
      );
      const detail = await getCompany(ids[0]!);
      expect(
        detail?.scores.map((row) => [
          row.campaign_id,
          row.campaign_name,
          row.score,
        ]),
      ).toEqual([
        [otherCampaignId, `${prefix}-other`, 99],
        [campaignId, prefix, 10],
      ]);
      const filteredExport = [];
      for await (const row of exportCompanies({ campaignId, minScore: 50 }))
        filteredExport.push(row.id);
      expect(filteredExport).toEqual(tied);
      const exported = [];
      for await (const row of exportCompanies({ campaignId }))
        exported.push(row.id);
      expect(exported).toHaveLength(27);
      expect(new Set(exported).size).toBe(27);
      const {
        rows: [platforms],
      } = await sonarPool.query(
        "select value from settings where key='platforms.domains'",
      );
      const domain = platforms.value[0];
      expect(typeof domain).toBe('string');
      for (const [index, value] of [
        domain,
        `branch.${domain}`,
        `evil${domain}`,
        null,
      ].entries())
        await sonarPool.query('update companies set domain=$2 where id=$1', [
          ids[index],
          value,
        ]);
      const platformOnly = await listCompanies({
        campaignId,
        platforms: 'only',
      });
      expect(platformOnly.total).toBe(2);
      expect(platformOnly.companies.every((row) => row.platform)).toBe(true);
      expect(
        (await listCompanies({ campaignId, platforms: 'exclude' })).total,
      ).toBe(25);
      expect(
        (await listCompanies({ campaignId, platforms: 'all' })).total,
      ).toBe(27);
      const interrupted = exportCompanies({ campaignId });
      await interrupted.next();
      await interrupted.return();
    } finally {
      await sonarPool.query(
        'delete from company_scores where company_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query(
        'delete from contacts where company_id=any($1::uuid[])',
        [ids],
      );
      await sonarPool.query(
        'delete from campaign_companies where campaign_id=any($1::uuid[])',
        [[campaignId, otherCampaignId].filter(Boolean)],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query(
        'delete from activity_log where entity_id=any($1::text[])',
        [[campaignId, otherCampaignId].filter(Boolean)],
      );
      await sonarPool.query(
        'delete from batches where campaign_id=any($1::uuid[])',
        [[campaignId, otherCampaignId].filter(Boolean)],
      );
      await sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
        [campaignId, otherCampaignId].filter(Boolean),
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
