import { beforeEach, expect, it, vi } from 'vitest';
import type { RegistryEntity } from '@sonar/core';

const { query, registryQuery, connect, release } = vi.hoisted(() => ({
  query: vi.fn(),
  registryQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { query },
  registryPool: { connect },
}));
import { registryAlternatives, registryRead } from './registry-lookup.js';

const entity = (id: string, name: string): RegistryEntity => ({
  entity_type: 'FOP',
  id,
  name,
  edrpou: null,
  short_name: null,
  status: 'зареєстровано',
  registration_date: null,
  termination_date: null,
  director: null,
  address: 'Київ, вул. Хрещатик, 1',
  published_at: '2026-10-01',
});
function evidence(
  names: string[] = [],
  identities: { entity_type: string; entity_id: string }[] = [],
  address: string | null = null,
) {
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('from company_facts')
      ? names.map((value) => ({ kind: 'fop_name', value }))
      : sql.includes('from registry_phones')
        ? identities
        : [{ address }],
  }));
}
beforeEach(() => {
  vi.resetAllMocks();
  connect.mockResolvedValue({ query: registryQuery, release });
  registryQuery.mockResolvedValue({ rows: [] });
  evidence();
});

it('finds indexed E.164 phone identities in Sonar and reads registry entities by ID only', async () => {
  const match = entity('7', 'ПЕТРЕНКО ІВАН ПЕТРОВИЧ');
  evidence([], [{ entity_type: 'FOP', entity_id: '7' }]);
  registryQuery.mockImplementation(async (sql: string) => ({
    rows: sql.includes('where e.id=$1') ? [match] : [],
  }));
  await expect(registryAlternatives('c')).resolves.toEqual([
    { entity: match, method: 'phone', review: false },
  ]);
  const phoneSql = query.mock.calls.find(([sql]) =>
    String(sql).includes('from registry_phones'),
  )!;
  expect(phoneSql[0]).toContain('c.normalized=r.phone_e164');
  expect(phoneSql[0]).toContain("c.source<>'registry'");
  expect(phoneSql[1]).toEqual(['c']);
  expect(registryQuery).toHaveBeenCalledWith(
    expect.stringContaining('where e.id=$1'),
    ['7'],
  );
  expect(registryQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
    'begin read only',
    "set local statement_timeout = '5s'",
    expect.stringContaining('from public.edr_fops'),
    'commit',
  ]);
  expect(release).toHaveBeenCalledOnce();
});

it('looks up full website FOP names using lowercase exact indexed names and apostrophe variants', async () => {
  const match = entity('8', 'МАР’ЯНЕНКО АННА ЮРІЇВНА');
  evidence(['  МАР’ЯНЕНКО\u00a0 АННА   ЮРІЇВНА  ']);
  registryQuery.mockImplementation(async (sql: string) => ({
    rows: sql.includes('md5(e.normalized_name)') ? [match] : [],
  }));
  await expect(registryAlternatives('c')).resolves.toEqual([
    { entity: match, method: 'fop_name', review: false },
  ]);
  const [sql, params] = registryQuery.mock.calls.find(([sql]) =>
    String(sql).includes('md5(e.normalized_name)'),
  )!;
  expect(sql).toContain('e.normalized_name=any($1::text[])');
  expect(params).toEqual([
    [
      "мар'яненко анна юріївна",
      'мар’яненко анна юріївна',
      'марʼяненко анна юріївна',
    ],
  ]);
  expect(query.mock.calls[0]![0]).toContain("source='website'");
  expect(query.mock.calls[0]![0]).toContain('expires_at>now()');
});

it('keeps initials matched by phone for manual review even without an address', async () => {
  const match = entity('9', 'КОВАЛЬЧУК ОЛЕГ ІВАНОВИЧ');
  evidence(['Ковальчук О . І .'], [{ entity_type: 'FOP', entity_id: '9' }]);
  registryQuery.mockImplementation(async (sql: string) => ({
    rows: sql.includes('where e.id=$1') ? [match] : [],
  }));
  await expect(registryAlternatives('c')).resolves.toEqual([
    { entity: match, method: 'phone', review: true },
  ]);
  expect(
    registryQuery.mock.calls.some(([sql]) =>
      /normalized_name|edr_contacts/.test(String(sql)),
    ),
  ).toBe(false);
});

it('requires an exact address and both initials for surname candidates and marks them for review', async () => {
  const match = entity('9', 'КОВАЛЬЧУК ОЛЕГ ІВАНОВИЧ');
  evidence(['Ковальчук О.І.'], [], match.address);
  registryQuery.mockImplementation(async (sql: string) => ({
    rows: sql.includes('e.normalized_name like')
      ? [match, entity('10', 'КОВАЛЬЧУК ОЛЕГ ПЕТРОВИЧ')]
      : [],
  }));
  await expect(registryAlternatives('c')).resolves.toEqual([
    { entity: match, method: 'fop_initials_address', review: true },
  ]);
  expect(registryQuery).toHaveBeenCalledWith(
    expect.stringContaining(
      'e.normalized_name like $1 and e.address=$2 limit 101',
    ),
    ['ковальчук %', match.address],
  );
});

it('does not search registry names for initials without a phone or address', async () => {
  evidence(['Ковальчук О.І.']);
  await expect(registryAlternatives('c')).resolves.toEqual([]);
  expect(
    registryQuery.mock.calls.some(([sql]) => /\bselect\b/i.test(String(sql))),
  ).toBe(false);
});

it('rolls back and releases the read-only registry transaction on failure', async () => {
  await expect(
    registryRead(async () => {
      throw new Error('registry unavailable');
    }),
  ).rejects.toThrow('registry unavailable');
  expect(registryQuery).toHaveBeenCalledWith('begin read only');
  expect(registryQuery).toHaveBeenCalledWith('rollback');
  expect(registryQuery).not.toHaveBeenCalledWith('commit');
  expect(release).toHaveBeenCalledOnce();
});
