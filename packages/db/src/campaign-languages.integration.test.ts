import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it.skipIf(process.env.RUN_DB_TESTS !== '1')(
  'migrates paid and fixture cursors with original languages and idempotent data steps',
  async () => {
    const { sonarPool, registryPool } = await import('./index.js');
    const client = await sonarPool.connect();
    const query = 'repair "special"\\name';
    const city = 'Київ';
    const old = JSON.stringify([query, city]);
    const target = JSON.stringify([query, city, 'pl']);
    const paid = {
      pages: 1,
      token: 'already-paid',
      exhausted: false,
      buffer: [{ id: 'paid' }],
    };
    try {
      await client.query('begin');
      await client.query(
        "create temp table campaigns(id uuid,language_code text,google_progress jsonb,language_codes text[] default ARRAY['uk']) on commit drop",
      );
      await client.query(
        'create temp table batches(id uuid,campaign_id uuid,config jsonb,fixture boolean default false) on commit drop',
      );
      await client.query(
        'create temp table tasks(id uuid,batch_id uuid,type text,status text,idempotency_key text,created_at timestamptz) on commit drop',
      );
      await client.query(
        'create temp table spend_events(task_id uuid,meta jsonb,created_at timestamptz) on commit drop',
      );
      await client.query(
        'insert into campaigns(id,language_code,google_progress) values(gen_random_uuid(),$1,$2)',
        [
          'uk',
          JSON.stringify({
            [old]: paid,
            '["removed","old-city"]': paid,
            '["fixture","city"]': paid,
            unrelated: paid,
            '["other","city","en"]': paid,
          }),
        ],
      );
      await client.query(
        'insert into batches(id,campaign_id,config) select gen_random_uuid(),id,$1 from campaigns',
        [
          JSON.stringify({
            language_code: 'pl',
            queries: [query, 'removed'],
            cities: [city, 'old-city'],
          }),
        ],
      );
      await client.query(
        'insert into batches select gen_random_uuid(),id,$1,true from campaigns',
        [
          JSON.stringify({
            language_code: 'de',
            queries: ['fixture'],
            cities: ['city'],
          }),
        ],
      );
      await client.query(
        "insert into tasks select gen_random_uuid(),b.id,'google.request','done','google.request:'||b.id||':'||n||':0',now() from batches b cross join unnest(ARRAY[0,3]) n",
      );
      await client.query(
        'insert into spend_events select t.id,\'{"response":{}}\'::jsonb,now() from tasks t join batches b on b.id=t.batch_id where not b.fixture',
      );
      await client.query(
        "update campaigns set language_codes=ARRAY['uk','en']",
      );
      const migration = readFileSync(
        new URL('../drizzle/0076_campaign_languages.sql', import.meta.url),
        'utf8',
      );
      const sql = migration.split('--> statement-breakpoint')[1]!;
      const backfill = migration.slice(
        migration.indexOf('UPDATE campaigns'),
        migration.indexOf('--> statement-breakpoint'),
      );
      await client.query(backfill);
      await client.query(sql);
      const {
        rows: [row],
      } = await client.query('select google_progress from campaigns');
      expect(row.google_progress[old]).toEqual(paid);
      expect(row.google_progress[target]).toEqual(paid);
      expect(row.google_progress['["removed","old-city","pl"]']).toEqual(paid);
      expect(row.google_progress['["fixture","city","de"]']).toEqual(paid);
      expect(
        row.google_progress[JSON.stringify([query, city, 'uk'])],
      ).toBeUndefined();
      expect(row.google_progress['["other","city","en"]']).toEqual(paid);
      await client.query(backfill);
      await client.query(sql);
      expect(
        (await client.query('select language_codes from campaigns')).rows[0]
          .language_codes,
      ).toEqual(['uk', 'en']);
      expect(
        (await client.query('select google_progress from campaigns')).rows[0]
          .google_progress,
      ).toEqual(row.google_progress);
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.all([sonarPool.end(), registryPool.end()]);
    }
  },
);
