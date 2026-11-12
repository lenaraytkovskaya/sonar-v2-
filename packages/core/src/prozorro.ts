import { normalizePhone, type CountryCode } from './index.js';

export type ProzorroDocType = 'tender' | 'contract';
export type ProzorroRole = 'supplier' | 'tenderer' | 'buyer';
export type ProzorroParty = {
  code: string;
  scheme: string | null;
  name: string | null;
  contactName: string | null;
  email: string | null;
  telephone: string | null;
  url: string | null;
  role: ProzorroRole;
};
export type ProzorroDocument = {
  docType: ProzorroDocType;
  docId: string;
  publicId: string | null;
  sourceUrl: string;
  title: string | null;
  amount: string | null;
  currency: string | null;
  date: Date;
  parties: ProzorroParty[];
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// Masked identifiers must never become a valid company code by removing punctuation.
export function prozorroCode(value: unknown): string | null {
  const code = text(value);
  return code && /^(?:\d{8}|\d{10})$/.test(code) ? code : null;
}

export function extractProzorroDocument(
  docType: ProzorroDocType,
  raw: unknown,
  defaultCountry: CountryCode = 'UA',
): ProzorroDocument {
  const wrapper = record(raw);
  const doc = wrapper.data ? record(wrapper.data) : wrapper;
  const docId = text(doc.id);
  const date = new Date(
    text(doc.dateSigned) ?? text(doc.date) ?? text(doc.dateModified) ?? '',
  );
  if (!docId || !Number.isFinite(date.getTime()))
    throw new Error('Invalid Prozorro document identifier or date');
  const publicId = text(docType === 'tender' ? doc.tenderID : doc.contractID);
  const parties = new Map<string, ProzorroParty>();
  const maskedCodes = new Map<string, string>();
  const add = (rawParty: unknown, role: ProzorroRole) => {
    const party = record(rawParty);
    const identifier = record(party.identifier);
    const contact = record(party.contactPoint);
    const rawEmail = text(contact.email);
    const email =
      rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
        ? rawEmail.toLowerCase()
        : null;
    const telephone = normalizePhone(
      text(contact.telephone) ?? '',
      defaultCountry,
    );
    const name = text(party.name) ?? text(identifier.legalName);
    const scheme = text(identifier.scheme);
    const code = scheme === 'UA-EDR' ? prozorroCode(identifier.id) : null;
    // Redacted identity keys stay local; bounded ordinal codes cannot match an entity.
    const identity = JSON.stringify([
      identifier.id ?? null,
      scheme,
      name,
      email,
      telephone,
    ]);
    if (!maskedCodes.has(identity))
      maskedCodes.set(identity, `masked:${maskedCodes.size}`);
    const key = code ?? maskedCodes.get(identity)!;
    if (!code && !email && !telephone && !name && !text(identifier.id)) return;
    const incoming: ProzorroParty = {
      code: key,
      scheme,
      name,
      contactName: text(contact.name),
      email,
      telephone,
      url: text(contact.url) ?? text(party.url),
      role,
    };
    const previous = parties.get(`${role}:${key}`);
    if (previous) {
      for (const field of [
        'scheme',
        'name',
        'contactName',
        'email',
        'telephone',
        'url',
      ] as const)
        previous[field] ??= incoming[field];
    } else parties.set(`${role}:${key}`, incoming);
  };
  if (docType === 'contract') {
    for (const supplier of list(doc.suppliers)) add(supplier, 'supplier');
    if (doc.buyer) add(doc.buyer, 'buyer');
  } else {
    for (const award of list(doc.awards))
      for (const supplier of list(record(award).suppliers))
        add(supplier, 'supplier');
    for (const bid of list(doc.bids))
      for (const tenderer of list(record(bid).tenderers))
        add(tenderer, 'tenderer');
    if (doc.procuringEntity) add(doc.procuringEntity, 'buyer');
  }
  const value = record(doc.value);
  return {
    docType,
    docId,
    publicId,
    sourceUrl: `https://prozorro.gov.ua/uk/${docType}/${encodeURIComponent(publicId ?? docId)}`,
    title: text(doc.title) ?? text(record(list(doc.items)[0]).description),
    amount:
      typeof value.amount === 'number' &&
      Number.isFinite(value.amount) &&
      value.amount >= 0
        ? String(value.amount)
        : null,
    currency: text(value.currency),
    date,
    parties: [...parties.values()],
  };
}
