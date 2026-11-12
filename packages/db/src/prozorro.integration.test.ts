import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { extractProzorroDocument } from '@sonar/core';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
const companyId = randomUUID();
const maskedCompanyId = randomUUID();
const prefix = randomUUID();
const key = `prozorro.test.${prefix}`;
const doc = (index: number, masked = false) =>
  extractProzorroDocument('tender', {
    id: `${prefix}-${index}`,
    tenderID: `UA-2026-11-12-${prefix}-${index}`,
    dateModified: `2026-11-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
    title: `Fixture ${index}`,
    value: { amount: 100 + index, currency: 'UAH' },
    awards: [
      {
        suppliers: [
          {
            identifier: {
              id: masked ? '12*****678' : '00123456',
              scheme: masked ? 'UA-IPN' : 'UA-EDR',
            },
            name: 'Fixture supplier',
            contactPoint: {
              name: 'Олена',
              email: masked ? 'masked@example.test' : 'fixture@example.test',
              telephone: '0671234567',
            },
          },
        ],
      },
    ],
  });

it.skipIf(!enabled)(
  'replaces document extraction and checkpoint atomically; matches masked evidence and preserves provenance idempotently',
  async () => {
    db = await import('./index.js');
    const {
      saveProzorroPage,
      matchProzorroCompany,
      getProzorroCompanySummary,
    } = await import('./prozorro.js');
    for (const id of [companyId, maskedCompanyId])
      await db.sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1,$2,'Prozorro fixture','UA')",
        [id, id],
      );
    await db.sonarPool.query(
      "insert into company_facts(company_id,kind,value,source) values($1,'edrpou','\"00123456\"','registry')",
      [companyId],
    );
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'email','masked@example.test','masked@example.test','website')",
      [maskedCompanyId],
    );
    const documents = [doc(0), doc(1), doc(2), doc(3)];
    expect(
      await saveProzorroPage(documents, key, { offset: 'next', documents: 4 }),
    ).toMatchObject({ rows: 4 });
    expect(
      await saveProzorroPage(documents, key, { offset: 'next', documents: 4 }),
    ).toMatchObject({ rows: 4 });
    expect(await matchProzorroCompany(companyId)).toMatchObject({
      matched: 4,
      contacts: 2,
    });
    expect(await matchProzorroCompany(companyId)).toMatchObject({
      matched: 4,
      contacts: 0,
    });
    const summary = await getProzorroCompanySummary(companyId);
    expect(summary.count).toBe(4);
    expect(summary.latest.map((d) => d.docId)).toEqual([
      documents[3]!.docId,
      documents[2]!.docId,
      documents[1]!.docId,
    ]);
    const { rows: contacts } = await db.sonarPool.query(
      'select source,source_url,found_at from contacts where company_id=$1',
      [companyId],
    );
    expect(contacts).toHaveLength(2);
    expect(
      contacts.every(
        (c) =>
          c.source === 'prozorro' &&
          c.source_url.includes('UA-2026') &&
          c.found_at instanceof Date,
      ),
    ).toBe(true);
    expect(
      (
        await db.sonarPool.query(
          "select value,source_url,found_at from company_facts where company_id=$1 and kind='contact_person'",
          [companyId],
        )
      ).rows,
    ).toEqual([
      {
        value: 'Олена',
        source_url: documents[3]!.sourceUrl,
        found_at: documents[3]!.date,
      },
    ]);
    const masked = doc(4, true);
    await saveProzorroPage([masked], key, { offset: 'masked', documents: 5 });
    expect(await matchProzorroCompany(maskedCompanyId)).toMatchObject({
      matched: 1,
      contacts: 1,
    });
    // Newly learned shared contacts must not transitively identify other suppliers.
    expect(await matchProzorroCompany(companyId)).toMatchObject({
      matched: 4,
      contacts: 0,
    });
    expect(await matchProzorroCompany(maskedCompanyId)).toMatchObject({
      matched: 1,
      contacts: 0,
    });
    expect((await getProzorroCompanySummary(companyId)).count).toBe(4);
    expect((await getProzorroCompanySummary(maskedCompanyId)).count).toBe(1);
    const bad = {
      ...documents[0]!,
      parties: [documents[0]!.parties[0]!, documents[0]!.parties[0]!],
    };
    await expect(
      saveProzorroPage([{ ...documents[1]!, parties: [] }, bad], key, {
        offset: 'bad',
        documents: 6,
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      (
        await db.sonarPool.query('select value from settings where key=$1', [
          key,
        ])
      ).rows[0].value,
    ).toMatchObject({ offset: 'masked', rows: 5 });
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::int as count from prozorro_parties where doc_id=$1',
          [documents[1]!.docId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      await saveProzorroPage([{ ...masked, parties: [] }], key, {
        offset: 'removed',
        documents: 6,
      }),
    ).toMatchObject({ rows: 4 });
  },
);
afterAll(async () => {
  if (!db) return;
  for (const table of ['company_facts', 'contacts'])
    await db.sonarPool.query(
      `delete from ${table} where company_id=any($1::uuid[])`,
      [[companyId, maskedCompanyId]],
    );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    [companyId, maskedCompanyId],
  ]);
  await db.sonarPool.query(
    'delete from prozorro_parties where doc_id like $1',
    [`${prefix}%`],
  );
  await db.sonarPool.query('delete from settings where key=$1', [key]);
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
