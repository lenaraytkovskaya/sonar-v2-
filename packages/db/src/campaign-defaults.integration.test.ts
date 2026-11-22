import { afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCampaignDraft } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'seeds defaults idempotently without replacing administrator settings',
  async () => {
    const { sonarPool } = await import('./index.js');
    const client = await sonarPool.connect();
    try {
      await client.query('begin');
      await client.query(
        'create temp table settings(key text primary key,value jsonb,updated_at timestamptz default now()) on commit drop',
      );
      await client.query(
        "insert into settings(key,value) values('campaign.defaults','{\"custom\":true}')",
      );
      const sql = readFileSync(
        new URL('../drizzle/0081_campaign_defaults.sql', import.meta.url),
        'utf8',
      );
      await client.query(sql);
      await client.query(sql);
      expect(
        (await client.query('select value from settings')).rows[0].value,
      ).toEqual({ custom: true });
      await client.query('delete from settings');
      await client.query(sql);
      await client.query(sql);
      const rows = (await client.query('select value from settings')).rows;
      expect(rows).toHaveLength(1);
      expect(createCampaignDraft(rows[0].value, { website: 17 })).toMatchObject(
        {
          country_code: 'UA',
          language_code: 'uk',
          language_codes: ['uk'],
          batch_size: 20,
          budget_usd: 0,
          send_mode: 'manual',
          min_score: 40,
          product_id: null,
          scoring_weights: { website: 17 },
        },
      );
    } finally {
      await client.query('rollback');
      client.release();
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
