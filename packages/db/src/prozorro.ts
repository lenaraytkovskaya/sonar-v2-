import { prozorroCode, type ProzorroDocument } from '@sonar/core';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';

// A page and its continuation are committed together; replay replaces stale participants.
export async function saveProzorroPage(
  documents: ProzorroDocument[],
  progressKey: string,
  progress: Record<string, unknown>,
) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const { rows: settings } = await client.query(
      'select value from settings where key=$1 for update',
      [progressKey],
    );
    let delta = 0;
    for (const document of documents) {
      const removed = await client.query(
        'delete from prozorro_parties where doc_type=$1 and doc_id=$2',
        [document.docType, document.docId],
      );
      delta -= removed.rowCount ?? 0;
      if (!document.parties.length) continue;
      const inserted = await client.query(
        `insert into prozorro_parties(code,scheme,name,contact_name,email,telephone,url,role,doc_type,doc_id,public_id,source_url,title,amount,currency,date)
         select p.code,p.scheme,p.name,p."contactName",p.email,p.telephone,p.url,p.role,$2,$3,$4,$5,$6,$7,$8,$9
         from jsonb_to_recordset($1::jsonb) as p(code text,scheme text,name text,"contactName" text,email text,telephone text,url text,role text)`,
        [
          JSON.stringify(document.parties),
          document.docType,
          document.docId,
          document.publicId,
          document.sourceUrl,
          document.title,
          document.amount,
          document.currency,
          document.date,
        ],
      );
      delta += inserted.rowCount ?? 0;
    }
    const updated = {
      ...progress,
      rows: Math.max(0, Number(settings[0]?.value?.rows ?? 0) + delta),
    };
    await client.query(
      'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value,updated_at=now()',
      [progressKey, JSON.stringify(updated)],
    );
    await client.query('commit');
    return updated;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type PartyRow = {
  doc_type: 'tender' | 'contract';
  doc_id: string;
  title: string | null;
  amount: string | null;
  currency: string | null;
  date: Date;
  source_url: string;
  role: 'supplier' | 'tenderer' | 'buyer';
  email: string | null;
  telephone: string | null;
  contact_name: string | null;
};
async function matchingKeys(
  client: Pick<PoolClient, 'query'>,
  companyId: string,
) {
  const { rows: facts } = await client.query(
    "select value from company_facts where company_id=$1 and kind in ('edrpou','ipn')",
    [companyId],
  );
  const codes = [
    ...new Set(
      facts
        .map(({ value }) =>
          value && typeof value === 'object' && value.valid === false
            ? null
            : prozorroCode(
                typeof value === 'object' && value ? value.code : value,
              ),
        )
        .filter(Boolean),
    ),
  ];
  // Only independent evidence can seed identity; learned contacts must not expand it.
  const { rows: contacts } = await client.query(
    "select kind,normalized from contacts where company_id=$1 and kind in ('phone','email') and source<>'prozorro'",
    [companyId],
  );
  const phones = contacts
    .filter((c) => c.kind === 'phone')
    .map((c) => c.normalized);
  const emails = contacts
    .filter((c) => c.kind === 'email')
    .map((c) => String(c.normalized).toLowerCase());
  return [codes, phones, emails];
}
// Independent indexed branches avoid a sequential OR scan on a large local index.
const matchingSql = `select * from prozorro_parties where code=any($1::text[]) and scheme='UA-EDR'
  union select * from prozorro_parties where telephone=any($2::text[])
  union select * from prozorro_parties where email=any($3::text[])`;

export async function matchProzorroCompany(companyId: string) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    await client.query('select id from companies where id=$1 for update', [
      companyId,
    ]);
    const { rows: parties } = await client.query<PartyRow & { total: string }>(
      `with matched as (${matchingSql}),
       counted as (select *,count(*) over()::text as total from matched)
       select distinct on(email,telephone,contact_name) * from counted
       order by email,telephone,contact_name,date desc,doc_type,doc_id`,
      await matchingKeys(client, companyId),
    );
    let contacts = 0;
    for (const party of parties) {
      for (const [kind, value] of [
        ['email', party.email],
        ['phone', party.telephone],
      ] as const) {
        if (!value) continue;
        const inserted = await client.query(
          `insert into contacts(company_id,kind,value,normalized,source,source_url,found_at)
           values($1,$2,$3,$3,'prozorro',$4,$5)
           on conflict(company_id,kind,normalized) do update
           set meta=contacts.meta || '{"alsoInProzorro":true}'::jsonb,
           source_url=case when contacts.source='prozorro' and contacts.found_at < excluded.found_at then excluded.source_url else contacts.source_url end,
           found_at=case when contacts.source='prozorro' then greatest(contacts.found_at,excluded.found_at) else contacts.found_at end
           where not contacts.meta @> '{"alsoInProzorro":true}'::jsonb
              or (contacts.source='prozorro' and contacts.found_at < excluded.found_at)
           returning (xmax=0) as inserted`,
          [companyId, kind, value, party.source_url, party.date],
        );
        contacts += inserted.rows.filter((row) => row.inserted).length;
      }
      if (party.contact_name)
        await client.query(
          `insert into company_facts(company_id,kind,value,source,source_url,found_at)
         values($1,'contact_person',$2,'prozorro',$3,$4)
         on conflict(company_id,kind,source,(md5(value::text))) do update
         set source_url=excluded.source_url,found_at=excluded.found_at
         where company_facts.found_at < excluded.found_at`,
          [
            companyId,
            JSON.stringify(party.contact_name),
            party.source_url,
            party.date,
          ],
        );
    }
    await client.query('commit');
    return { matched: Number(parties[0]?.total ?? 0), contacts };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getProzorroCompanySummary(companyId: string) {
  const { rows } = await sonarPool.query<PartyRow & { total: string }>(
    `with matched as (${matchingSql}),
     docs as (select distinct on(doc_type,doc_id) * from matched order by doc_type,doc_id,role),
     latest as (select * from docs order by date desc,doc_type,doc_id limit 3)
     select latest.*,(select count(*) from docs)::text as total from latest order by date desc,doc_type,doc_id`,
    await matchingKeys(sonarPool, companyId),
  );
  return {
    count: Number(rows[0]?.total ?? 0),
    latest: rows.map((p) => ({
      docType: p.doc_type,
      docId: p.doc_id,
      title: p.title,
      amount: p.amount,
      currency: p.currency,
      date: p.date,
      sourceUrl: p.source_url,
      role: p.role,
    })),
  };
}
