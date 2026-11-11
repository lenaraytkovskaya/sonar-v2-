import { randomUUID } from 'node:crypto';
import {
  manualCompanySchema,
  manualContactSchema,
  normalizeManualContact,
  normalizeWebsite,
  type CountryCode,
  type ManualCompanyInput,
  type ManualContactInput,
} from '@sonar/core';
import { transaction } from './email.js';
import { logActivity } from './tasks.js';

export type ManualEntryErrorCode =
  | 'invalidContact'
  | 'invalidCompany'
  | 'companyNotFound'
  | 'campaignNotFound'
  | 'duplicateContact'
  | 'duplicateCompany'
  | 'contactBlocked'
  | 'manualOnly'
  | 'contactNotFound';
export class ManualEntryError extends Error {
  constructor(
    public code: ManualEntryErrorCode,
    public reasonUk?: string,
  ) {
    super(code);
  }
}
const fail = (code: ManualEntryErrorCode): never => {
  throw new ManualEntryError(code);
};

export async function addManualContact(
  companyId: string,
  input: ManualContactInput,
  userId: string,
) {
  const parsed = manualContactSchema.safeParse(input);
  if (!parsed.success) fail('invalidContact');
  const data = parsed.data!;
  return transaction(async (c) => {
    const {
      rows: [company],
    } = await c.query(
      `select c.*,coalesce(c.country_code,(select a.country_code from campaign_companies cc join campaigns a on a.id=cc.campaign_id where cc.company_id=c.id order by cc.added_at desc limit 1)) as country from companies c where c.id=$1 for update`,
      [companyId],
    );
    if (!company) fail('companyNotFound');
    const contact = normalizeManualContact(
      data,
      company.country as CountryCode,
    );
    if (!contact) fail('invalidContact');
    if (['refused', 'do_not_contact'].includes(company.status))
      fail('contactBlocked');
    const normalized = contact!.value;
    const contactDomain =
      data.kind === 'email'
        ? normalized.split('@')[1]
        : data.kind === 'form'
          ? new URL(normalized).hostname
          : null;
    const {
      rows: [block],
    } = await c.query(
      `select reason from do_not_contact where company_id=$1 or (kind='company' and value_normalized=$1::text) or (kind=$2 and value_normalized=$3) or (kind='domain' and lower(value_normalized) in (lower($4),lower($5))) limit 1`,
      [companyId, data.kind, normalized, company.domain, contactDomain],
    );
    if (block) throw new ManualEntryError('contactBlocked', block.reason);
    const {
      rows: [row],
    } = await c.query(
      `insert into contacts(company_id,kind,value,normalized,source,rank,meta) values($1,$2,$3,$4,'manual',$5,$6) on conflict(company_id,kind,normalized) do nothing returning *`,
      [
        companyId,
        data.kind,
        data.value,
        normalized,
        contact!.rank,
        { ...contact!.meta, created_by: userId, note: data.note ?? '' },
      ],
    );
    if (!row) fail('duplicateContact');
    await logActivity(
      'contact.manual.created',
      'company',
      companyId,
      userId,
      { contactId: row.id, kind: data.kind, value: normalized },
      c,
    );
    return row;
  });
}

export async function deleteManualContact(
  companyId: string,
  contactId: string,
  userId: string,
) {
  return transaction(async (c) => {
    const {
      rows: [contact],
    } = await c.query(
      'select * from contacts where id=$1 and company_id=$2 for update',
      [contactId, companyId],
    );
    if (!contact) fail('contactNotFound');
    if (contact.source !== 'manual') fail('manualOnly');
    await c.query(
      'update conversations set contact_id=null where contact_id=$1',
      [contactId],
    );
    await c.query('delete from contacts where id=$1', [contactId]);
    await logActivity(
      'contact.manual.deleted',
      'company',
      companyId,
      userId,
      {
        contactId,
        kind: contact.kind,
        value: contact.normalized,
        meta: contact.meta,
      },
      c,
    );
    return { id: contactId };
  });
}

export async function createManualCompany(
  input: ManualCompanyInput,
  userId: string,
) {
  const parsed = manualCompanySchema.safeParse(input);
  if (!parsed.success) fail('invalidCompany');
  const data = parsed.data!;
  const site = normalizeWebsite(data.website);
  const website = site?.website ?? null;
  const domain = site?.domain ?? null;
  return transaction(async (c) => {
    const {
      rows: [campaign],
    } = await c.query('select id from campaigns where id=$1 for key share', [
      data.campaignId,
    ]);
    if (!campaign) fail('campaignNotFound');
    // Serialize manual creation so concurrent requests cannot create duplicate domains/names.
    await c.query("select pg_advisory_xact_lock(hashtext('manual.company'))");
    const {
      rows: [duplicate],
    } = await c.query(
      `select id from companies where ($1::text is not null and lower(domain)=$1) or (lower(name)=lower($2) and lower(coalesce(city,''))=lower($3) and country_code=$4) limit 1`,
      [domain, data.name, data.city ?? '', data.countryCode],
    );
    if (duplicate) fail('duplicateCompany');
    const {
      rows: [row],
    } = await c.query(
      `insert into companies(place_id,name,website,domain,city,country_code,status) values($1,$2,$3,$4,$5,$6,'new') returning *`,
      [
        'manual:' + randomUUID(),
        data.name,
        website,
        domain,
        data.city || null,
        data.countryCode,
      ],
    );
    await c.query(
      'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,null)',
      [data.campaignId, row.id],
    );
    await logActivity(
      'company.manual.created',
      'company',
      row.id,
      userId,
      { campaignId: data.campaignId },
      c,
    );
    return row;
  });
}
