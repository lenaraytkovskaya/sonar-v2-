import { normalizePhone } from './index.js';

export type RegistryEntityType = 'UO' | 'FOP' | 'FSU';
export const registryTables: Record<RegistryEntityType, string> = {
  UO: 'edr_legal_entities',
  FSU: 'edr_branches',
  FOP: 'edr_fops',
};
export type RegistryEntity = {
  entity_type: RegistryEntityType;
  id: string;
  edrpou: string | null;
  name: string | null;
  short_name: string | null;
  status: string | null;
  registration_date: string | null;
  termination_date: string | null;
  director: string | null;
  address: string | null;
  published_at: string | null;
};
export type RegistryContactRow = {
  kind: string;
  value: string;
  normalized_value: string;
  confidence: string | number;
};
export type RegistryFounderRow = {
  role: string;
  name: string | null;
  share: string | number | null;
  country: string | null;
};

// Registry normalized_name is lowercase; website typography may vary in spacing/apostrophes.
export function normalizeRegistryName(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

export function registryInitialsMatch(
  input: string,
  candidate: string,
): boolean {
  const initials = normalizeRegistryName(input).match(
    /^([^\s.]+)\s+([а-яіїєґ])\s*\.\s*([а-яіїєґ])\s*\.$/u,
  );
  const full = normalizeRegistryName(candidate).split(' ');
  return Boolean(
    initials &&
    full.length === 3 &&
    full.every((part) => /^[а-яіїєґ][а-яіїєґ'-]+$/u.test(part)) &&
    full[0] === initials[1] &&
    full[1]![0] === initials[2] &&
    full[2]![0] === initials[3],
  );
}

// Codes are taken only from evidence on the company's own site; invalid shapes are dropped.
export function registryCodes(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter(
          (value) =>
            !(
              value &&
              typeof value === 'object' &&
              (value as { valid?: unknown }).valid === false
            ),
        )
        .map((value) =>
          typeof value === 'string'
            ? value
            : value && typeof value === 'object' && 'code' in value
              ? String((value as { code: unknown }).code)
              : '',
        )
        .map((value) => value.replace(/\D/g, ''))
        .filter((value) => /^\d{8}$/.test(value)),
    ),
  ].slice(0, 3);
}

export function registryTerminated(status: string | null): boolean {
  return /припин|ліквід|банкрут/i.test(status ?? '');
}

// Prefer an active legal entity over branches and FOPs, and active over terminated.
export function pickRegistryEntity(rows: RegistryEntity[]) {
  const order: RegistryEntityType[] = ['UO', 'FSU', 'FOP'];
  return (
    [...rows].sort(
      (a, b) =>
        Number(registryTerminated(a.status)) -
          Number(registryTerminated(b.status)) ||
        order.indexOf(a.entity_type) - order.indexOf(b.entity_type),
    )[0] ?? null
  );
}

export function registryFacts(
  entity: RegistryEntity,
  founders: RegistryFounderRow[],
) {
  const facts: { kind: string; value: unknown }[] = [
    {
      kind: 'registry_entity',
      value: { type: entity.entity_type, id: entity.id },
    },
  ];
  const add = (kind: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '')
      facts.push({ kind, value });
  };
  add('edrpou', entity.edrpou);
  add('legal_name', entity.name);
  add('short_name', entity.short_name);
  add('registry_status', entity.status);
  add('registration_date', entity.registration_date);
  add('termination_date', entity.termination_date);
  add('director', entity.director);
  add('registered_address', entity.address);
  if (founders.length)
    add(
      'founders',
      founders.slice(0, 20).map((f) => ({
        role: f.role,
        name: f.name,
        share: f.share === null ? null : Number(f.share),
        country: f.country,
      })),
    );
  return facts;
}

export function registryContacts(rows: RegistryContactRow[]) {
  const contacts: {
    kind: 'phone' | 'email';
    value: string;
    normalized: string;
    confidence: number;
  }[] = [];
  for (const row of rows) {
    const kind = /phone|tel|тел/i.test(row.kind)
      ? 'phone'
      : /mail/i.test(row.kind)
        ? 'email'
        : null;
    if (!kind) continue;
    const normalized =
      kind === 'phone'
        ? normalizePhone(row.normalized_value || row.value, 'UA')
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.normalized_value.trim())
          ? row.normalized_value.trim().toLowerCase()
          : null;
    if (normalized)
      contacts.push({
        kind,
        value: row.value,
        normalized,
        confidence: Number(row.confidence) || 0,
      });
  }
  return contacts;
}
