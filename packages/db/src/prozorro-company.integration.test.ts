import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import type { ProzorroCompanySnapshot } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
const companyId = randomUUID();
it.skipIf(!enabled)(
  'replays company snapshots without duplicate facts/contacts and retains existing contact provenance',
  async () => {
    db = await import('./index.js');
    const {
      saveProzorroCompanySnapshot,
      getProzorroCompanySnapshot,
      prozorroCompanyCode,
    } = await import('./prozorro.js');
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$2,'Prozorro company fixture','UA')",
      [companyId, companyId],
    );
    await db.sonarPool.query(
      "insert into company_facts(company_id,kind,value,source) values($1,'edrpou','\"12345678\"','registry')",
      [companyId],
    );
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source,source_url) values($1,'email','test@example.test','test@example.test','website','https://example.test')",
      [companyId],
    );
    expect(await prozorroCompanyCode(companyId)).toBe('12345678');
    const sourceUrl = 'https://prozorro.gov.ua/tender/UA-2026-11-01-000001-a',
      date = '2026-11-01T00:00:00.000Z';
    const contacts = [
      { kind: 'email', value: 'test@example.test', sourceUrl, date },
      { kind: 'phone', value: '+380501234567', sourceUrl, date },
      { kind: 'name', value: 'Fixture Contact', sourceUrl, date },
    ];
    const snapshot = {
      code: '12345678',
      checkedAt: '2026-11-14T12:00:00.000Z',
      from: '2025-11-14',
      to: '2026-11-14',
      months: 12,
      searchTotal: 1,
      inspected: 1,
      matched: 1,
      coverage: 'all_period_results',
      tenders: [{ id: 'a'.repeat(32), contacts }],
    } as unknown as ProzorroCompanySnapshot;
    await saveProzorroCompanySnapshot(companyId, snapshot);
    await saveProzorroCompanySnapshot(companyId, snapshot);
    expect(await getProzorroCompanySnapshot(companyId)).toEqual(snapshot);
    const { rows } = await db.sonarPool.query(
      'select kind,source,source_url,meta from contacts where company_id=$1 order by kind',
      [companyId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'email',
      source: 'website',
      source_url: 'https://example.test',
      meta: { alsoInProzorro: true, prozorro: { sourceUrl, date } },
    });
    expect(rows[1]).toMatchObject({
      kind: 'phone',
      source: 'prozorro',
      source_url: sourceUrl,
    });
    const facts = await db.sonarPool.query(
      "select kind,count(*)::int as count from company_facts where company_id=$1 and source='prozorro' group by kind order by kind",
      [companyId],
    );
    expect(facts.rows).toEqual([
      { kind: 'contact_person', count: 1 },
      { kind: 'prozorro_company', count: 1 },
    ]);
    await saveProzorroCompanySnapshot(companyId, {
      ...snapshot,
      checkedAt: '2026-11-13T00:00:00.000Z',
    });
    expect(await getProzorroCompanySnapshot(companyId)).toEqual(snapshot);
    const bad = {
      ...snapshot,
      checkedAt: '2026-11-15T12:00:00.000Z',
      tenders: [{ contacts: [{ ...contacts[0], date: 'invalid timestamp' }] }],
    } as unknown as ProzorroCompanySnapshot;
    await expect(
      saveProzorroCompanySnapshot(companyId, bad),
    ).rejects.toMatchObject({ code: '22007' });
    expect(await getProzorroCompanySnapshot(companyId)).toEqual(snapshot);
  },
);
afterAll(async () => {
  if (!db) return;
  await db.sonarPool.query('delete from contacts where company_id=$1', [
    companyId,
  ]);
  await db.sonarPool.query('delete from company_facts where company_id=$1', [
    companyId,
  ]);
  await db.sonarPool.query('delete from companies where id=$1', [companyId]);
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
