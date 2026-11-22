import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contactFields } from '@sonar/core';
it.skipIf(process.env.RUN_DB_TESTS !== '1')(
  'adds the full contact mask without changing admin tariffs, basic settings or prior fields',
  async () => {
    const { sonarPool, registryPool } = await import('./index.js');
    const client = await sonarPool.connect();
    const contacts = {
      id: 'contacts',
      fields: ['places.id', 'places.websiteUri', 'nextPageToken'],
      priceUsd: 0.011,
      sku: 'Text Search Enterprise',
    };
    const basic = {
      id: 'basic',
      fields: ['places.id', 'nextPageToken'],
      priceUsd: 0.012,
      sku: 'Text Search Pro',
    };
    try {
      await client.query('begin');
      await client.query(
        'create temp table campaigns(field_profile text) on commit drop',
      );
      await client.query(
        'create temp table settings(key text,value jsonb,updated_at timestamptz) on commit drop',
      );
      await client.query("insert into campaigns values('basic'),('contacts')");
      await client.query(
        "insert into settings values('google.field_profiles',$1,now())",
        [JSON.stringify([contacts, basic])],
      );
      const sql = readFileSync(
        new URL('../drizzle/0077_campaign_contacts.sql', import.meta.url),
        'utf8',
      );
      await client.query(sql);
      const {
        rows: [row],
      } = await client.query('select value from settings');
      expect(row.value[0]).toMatchObject({
        priceUsd: contacts.priceUsd,
        sku: contacts.sku,
      });
      expect(row.value[0].fields).toEqual(
        expect.arrayContaining(contactFields),
      );
      expect(row.value[0].fields.slice(0, 3)).toEqual(contacts.fields);
      expect(row.value[1]).toEqual(basic);
      expect(
        (await client.query('select distinct field_profile from campaigns'))
          .rows,
      ).toEqual([{ field_profile: 'contacts' }]);
      await client.query(sql);
      expect(
        (await client.query('select value from settings')).rows[0].value,
      ).toEqual(row.value);
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.all([sonarPool.end(), registryPool.end()]);
    }
  },
);
