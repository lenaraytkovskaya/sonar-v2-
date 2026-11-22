import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { productSchema } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'migrates legacy product text losslessly, preserves existing links and reruns without duplicates',
  async () => {
    const { sonarPool } = await import('./index.js');
    const client = await sonarPool.connect();
    const sql = readFileSync(
      new URL('../drizzle/0078_campaign_product.sql', import.meta.url),
      'utf8',
    ).split('--> statement-breakpoint')[1]!;
    const emojiName = '😀'.repeat(200),
      emojiText = '😀'.repeat(10000);
    const offer = 'O'.repeat(20000),
      goal = 'G'.repeat(20000),
      longName = 'N'.repeat(200);
    try {
      await client.query('begin');
      await client.query(
        'create temp table products(like public.products including defaults including constraints) on commit drop',
      );
      await client.query(
        'create temp table activity_log(like public.activity_log including defaults) on commit drop',
      );
      await client.query(
        'create temp table campaigns(id uuid default gen_random_uuid(),name text,offer text,outreach_goal text,product_id uuid,created_by uuid) on commit drop',
      );
      const existing = (
        await client.query(
          "insert into products(name) values('Existing') returning id",
        )
      ).rows[0].id;
      await client.query(
        "insert into campaigns(name,offer,outreach_goal,product_id) values('Normal','Legacy','Goal',null),($1,$2,$3,null),('Linked','Keep','Keep',$4),('Blank',E'\n\t ',E' \t\n',null)",
        [longName, offer, goal, existing],
      );
      await client.query(
        "insert into campaigns(name,offer,outreach_goal) values($1,$2,'')",
        [emojiName, emojiText],
      );
      await client.query(
        "insert into campaigns(name,offer,outreach_goal) values('Unicode overflow',$1,$2)",
        ['😀'.repeat(6000), '😀'.repeat(4500)],
      );
      await client.query(sql);
      const rows = (
        await client.query(
          'select c.*,p.name as product_name,p.description,p.benefits from campaigns c left join products p on p.id=c.product_id order by c.name',
        )
      ).rows;
      const normal = rows.find((row) => row.name === 'Normal');
      const overflow = rows.find((row) => row.name === longName);
      expect(normal).toMatchObject({
        offer: 'Legacy',
        outreach_goal: 'Goal',
        description: 'Legacy\n\nМета: Goal',
        benefits: '',
      });
      expect(overflow).toMatchObject({
        offer,
        outreach_goal: goal,
        description: offer,
        benefits: goal,
      });
      expect(overflow.product_name).toHaveLength(120);
      expect(rows.find((row) => row.name === 'Unicode overflow')).toMatchObject(
        { description: '😀'.repeat(6000), benefits: '😀'.repeat(4500) },
      );
      const unicode = (
        await client.query(
          'select p.* from products p join campaigns c on c.product_id=p.id where c.name=$1',
          [emojiName],
        )
      ).rows[0];
      expect(unicode.name.length).toBeLessThanOrEqual(120);
      expect(unicode.description).toBe(emojiText);
      expect(() => productSchema.strip().parse(unicode)).not.toThrow();
      expect(rows.find((row) => row.name === 'Linked').product_id).toBe(
        existing,
      );
      expect(rows.find((row) => row.name === 'Blank').product_id).toBeNull();
      expect(
        (
          await client.query(
            'select details from activity_log where entity_id=$1',
            [overflow.product_id],
          )
        ).rows[0].details,
      ).toMatchObject({
        campaignId: overflow.id,
        campaignName: longName,
        overflowToBenefits: true,
      });
      await client.query(sql);
      expect(
        (await client.query('select count(*)::int as n from products')).rows[0]
          .n,
      ).toBe(5);
      expect(
        (await client.query('select count(*)::int as n from activity_log'))
          .rows[0].n,
      ).toBe(4);
      for (const fields of [
        [offer + 'X', ''],
        ['', goal + 'X'],
        [emojiText + '😀', ''],
        ['', emojiText + '😀'],
      ]) {
        await client.query('savepoint invalid_legacy');
        const id = (
          await client.query(
            "insert into campaigns(name,offer,outreach_goal) values('Invalid',$1,$2) returning id",
            fields,
          )
        ).rows[0].id;
        await expect(client.query(sql)).rejects.toThrow(id);
        await client.query('rollback to savepoint invalid_legacy');
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  },
);
it.skipIf(!enabled)(
  'preserves legacy fields on form saves and requires a product only for new batch launches',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { saveCampaign } = await import('./campaigns.js');
    const { createBatch, CampaignProductRequired } =
      await import('./batches.js');
    const prefix = randomUUID();
    let userId: string | undefined,
      productId: string | undefined,
      campaignId: string | undefined;
    try {
      userId = (
        await sonarPool.query(
          "insert into users(email,name,password_hash) values($1,'Test','unusable') returning id",
          [`${prefix}@example.invalid`],
        )
      ).rows[0].id;
      productId = (
        await sonarPool.query(
          "insert into products(name,status) values($1,'archived') returning id",
          [prefix],
        )
      ).rows[0].id;
      campaignId = (
        await sonarPool.query(
          "insert into campaigns(name,country_code,language_code,cities,queries,offer,outreach_goal,budget_usd,channels,scoring_weights,product_id) values($1,'UA','uk',ARRAY['City'],ARRAY['Query'],'Keep offer','Keep goal',1,'{}','{}',$2) returning id",
          [prefix, productId],
        )
      ).rows[0].id;
      const data = {
        name: prefix,
        country_code: 'UA',
        language_code: 'uk',
        cities: ['City'],
        queries: ['Query'],
        batch_size: 20 as const,
        budget_usd: 1,
        channels: {
          email: false,
          telegram: false,
          whatsapp: false,
          viber: false,
          forms: false,
        },
        send_mode: 'manual' as const,
        scoring_weights: {},
        status: 'draft' as const,
        field_profile: 'contacts' as const,
      };
      await saveCampaign(data, campaignId!, userId!);
      await saveCampaign(
        { ...data, offer: 'Do not write', outreach_goal: 'Do not write' },
        campaignId!,
        userId!,
      );
      expect(
        (
          await sonarPool.query(
            'select offer,outreach_goal,product_id from campaigns where id=$1',
            [campaignId],
          )
        ).rows[0],
      ).toEqual({
        offer: 'Keep offer',
        outreach_goal: 'Keep goal',
        product_id: productId,
      });
      const key = randomUUID();
      const batch = await createBatch(campaignId!, userId!, key, true, false);
      await sonarPool.query(
        'update campaigns set product_id=null where id=$1',
        [campaignId],
      );
      expect(
        (await createBatch(campaignId!, userId!, key, true, false)).id,
      ).toBe(batch.id);
      await expect(
        createBatch(campaignId!, userId!, randomUUID(), true, false),
      ).rejects.toBeInstanceOf(CampaignProductRequired);
    } finally {
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        campaignId,
      ]);
      await sonarPool.query('delete from batches where campaign_id=$1', [
        campaignId,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [campaignId]);
      await sonarPool.query('delete from products where id=$1', [productId]);
      await sonarPool.query('delete from users where id=$1', [userId]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
