import { normalizePhone } from './index.js';
import { prozorroCode } from './prozorro.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export type ProzorroContact = {
  kind: 'phone' | 'email' | 'name';
  value: string;
  sourceUrl: string;
  date: string;
};
export type CompanyTender = {
  id: string;
  tenderId: string;
  sourceUrl: string;
  date: string;
  participationDate: string;
  buyer: string;
  buyerCode: string;
  title: string;
  amount: number | null;
  currency: string;
  winner: boolean;
  wonAmounts: Record<string, number>;
  unpricedAwards: number;
  cpv: string[];
  contacts: ProzorroContact[];
};
export type ProzorroCompanySnapshot = {
  code: string;
  checkedAt: string;
  from: string;
  to: string;
  months: number;
  searchTotal: number;
  periodParticipationCount: number;
  periodCountExact: boolean;
  searchPages: number;
  searchRows: number;
  invalidRows: number;
  duplicateRows: number;
  dateConflicts: number;
  totalChanged: boolean;
  orderStable: boolean;
  searchExhausted: boolean;
  invalidDetails: number;
  unmatchedDetails: number;
  resolverRejected: number;
  searchTotalScope: 'all_time';
  searchTotalCapped: boolean;
  periodFilter: 'tenderID_publication_day';
  inspected: number;
  matched: number;
  coverage: 'sample' | 'all_period_results';
  tenders: CompanyTender[];
  wins: number;
  wonAmounts: Record<string, number>;
  unpricedAwards: number;
  lastParticipation: string | null;
  topBuyers: { name: string; code: string; count: number }[];
  cpv: string[];
};

// Exact identifier + scheme only: buyer names and contacts never establish participation.
export function extractCompanyTender(
  raw: unknown,
  code: string,
): CompanyTender | null {
  const doc = obj(obj(raw).data);
  if (
    !/^[a-f\d]{32}$/i.test(str(doc.id)) ||
    !/^UA-\d{4}-\d{2}-\d{2}-[\w-]+$/.test(str(doc.tenderID))
  )
    throw Error('Invalid Prozorro tender');
  const matches = (party: Obj) =>
    obj(party.identifier).scheme === 'UA-EDR' &&
    prozorroCode(obj(party.identifier).id) === code;
  const bids = arr(doc.bids).filter((b) => arr(b.tenderers).some(matches));
  const awards = arr(doc.awards).filter((a) => arr(a.suppliers).some(matches));
  const contracts = arr(doc.contracts).filter(
    (c) =>
      arr(c.suppliers).some(matches) ||
      (!arr(c.suppliers).length &&
        typeof c.awardID === 'string' &&
        awards.some((a) => a.id === c.awardID)),
  );
  const parties = [
    ...bids.flatMap((b) => arr(b.tenderers)),
    ...awards.flatMap((a) => arr(a.suppliers)),
    ...contracts.flatMap((c) => arr(c.suppliers)),
  ].filter(matches);
  if (!parties.length) return null;
  const sourceUrl = `https://prozorro.gov.ua/tender/${str(doc.tenderID)}`;
  const rawDate =
    str(obj(doc.tenderPeriod).startDate) ||
    str(doc.date) ||
    str(doc.dateModified);
  if (!Number.isFinite(Date.parse(rawDate)))
    throw Error('Invalid Prozorro tender date');
  const date = new Date(rawDate).toISOString();
  const dates = [...bids, ...awards, ...contracts]
    .map((x) => str(x.date) || str(x.dateSigned))
    .filter((x) => Number.isFinite(Date.parse(x)))
    .map((x) => new Date(x).toISOString());
  const participationDate = dates.sort().at(-1) ?? date;
  const contacts = new Map<string, ProzorroContact>();
  for (const party of parties) {
    const cp = obj(party.contactPoint);
    const email = str(cp.email).toLowerCase();
    const phone = normalizePhone(str(cp.telephone), 'UA');
    for (const [kind, value] of [
      ['name', str(cp.name)],
      ['phone', phone],
      ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null],
    ] as const)
      if (value)
        contacts.set(`${kind}:${value}`, {
          kind,
          value,
          sourceUrl,
          date: participationDate,
        });
  }
  const wonAmounts: Record<string, number> = {};
  const cancelled = doc.status === 'cancelled';
  const activeAwards = awards.filter(
    (a) => !cancelled && a.status === 'active',
  );
  const activeContracts = contracts.filter(
    (c) =>
      !cancelled &&
      ['active', 'terminated'].includes(str(c.status)) &&
      !arr(doc.awards).some((a) => a.id === c.awardID && a.status !== 'active'),
  );
  // A contract replaces its award value; several contracts for one award may be amendments.
  // Count the award once, using the latest contract value. Distinct lot awards remain separate.
  const units = new Map<string, Obj>();
  for (const [i, a] of activeAwards.entries())
    units.set(str(a.id) || `award:${i}`, a);
  for (const c of [...activeContracts].sort((a, b) =>
    (str(a.dateSigned) || str(a.date)).localeCompare(
      str(b.dateSigned) || str(b.date),
    ),
  ))
    units.set(str(c.awardID) || str(c.id), c);
  let unpricedAwards = 0;
  for (const unit of units.values()) {
    const value = obj(unit.value),
      currency = str(value.currency);
    if (
      currency &&
      typeof value.amount === 'number' &&
      Number.isFinite(value.amount) &&
      value.amount >= 0
    )
      wonAmounts[currency] =
        Math.round(((wonAmounts[currency] ?? 0) + value.amount) * 100) / 100;
    else unpricedAwards++;
  }
  const value = obj(doc.value),
    buyer = obj(doc.procuringEntity);
  return {
    id: str(doc.id),
    tenderId: str(doc.tenderID),
    sourceUrl,
    date,
    participationDate,
    title: str(doc.title),
    buyer: str(buyer.name),
    buyerCode: str(obj(buyer.identifier).id),
    amount:
      typeof value.amount === 'number' && Number.isFinite(value.amount)
        ? value.amount
        : null,
    currency: str(value.currency),
    winner: units.size > 0,
    wonAmounts,
    unpricedAwards,
    cpv: [
      ...new Set(
        arr(doc.items)
          .map((i) => str(obj(i.classification).id))
          .filter((code) => /^\d{8}-\d$/.test(code)),
      ),
    ],
    contacts: [...contacts.values()],
  };
}
export function summarizeCompanyTenders(tenders: CompanyTender[]) {
  const unique = [...new Map(tenders.map((t) => [t.id, t])).values()];
  const wonAmounts: Record<string, number> = {},
    buyers = new Map<string, { name: string; code: string; count: number }>();
  for (const t of unique) {
    for (const [currency, amount] of Object.entries(t.wonAmounts))
      wonAmounts[currency] =
        Math.round(((wonAmounts[currency] ?? 0) + amount) * 100) / 100;
    const key = t.buyerCode || t.buyer;
    const buyer = buyers.get(key) ?? {
      name: t.buyer,
      code: t.buyerCode,
      count: 0,
    };
    buyer.count++;
    buyers.set(key, buyer);
  }
  return {
    tenders: unique,
    matched: unique.length,
    wins: unique.filter((t) => t.winner).length,
    wonAmounts,
    unpricedAwards: unique.reduce((sum, t) => sum + t.unpricedAwards, 0),
    lastParticipation:
      unique
        .map((t) => t.participationDate)
        .sort()
        .at(-1) ?? null,
    topBuyers: [...buyers.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
    cpv: [...new Set(unique.flatMap((t) => t.cpv))],
  };
}
