import { beforeEach, expect, it, vi } from 'vitest';
const { query, connect } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { query, connect },
  registryPool: {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  },
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  logActivity: vi.fn(),
}));
import { runRegistryMatch } from './registry.js';
const company = (country: string | null) => ({
  rows: [{ id: 'c', country_code: country, campaign_country: 'UA' }],
});
beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  connect.mockReset();
});
it('skips non-Ukrainian companies without touching the registry', async () => {
  query.mockResolvedValueOnce(company('PL'));
  const lookup = vi.fn();
  await expect(
    runRegistryMatch({ companyId: 'c' }, 't', lookup),
  ).resolves.toMatchObject({
    status: 'skipped',
    reasonCode: 'registry_country',
  });
  expect(lookup).not.toHaveBeenCalled();
});
it('falls back when the website gave no valid code', async () => {
  query.mockResolvedValueOnce(company(null)).mockResolvedValueOnce({
    rows: [{ value: { code: '1234', valid: false } }],
  });
  const lookup = vi.fn();
  await expect(
    runRegistryMatch(
      { companyId: 'c' },
      't',
      lookup,
      vi.fn().mockResolvedValue([]),
    ),
  ).resolves.toMatchObject({ reasonCode: 'registry_not_found' });
  expect(lookup).not.toHaveBeenCalled();
});
it('tries each code and reports a code missing from the registry', async () => {
  query.mockResolvedValueOnce(company('UA')).mockResolvedValueOnce({
    rows: [{ value: { code: '40123456' } }, { value: '40123457' }],
  });
  const lookup = vi.fn().mockResolvedValue(null);
  await expect(
    runRegistryMatch({ companyId: 'c' }, 't', lookup),
  ).resolves.toMatchObject({ reasonCode: 'registry_not_found' });
  expect(lookup.mock.calls.map((call) => call[1])).toEqual([
    '40123456',
    '40123457',
  ]);
});
it('replaces the registry snapshot and saves contacts in one transaction', async () => {
  const tx = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  connect.mockResolvedValue(tx);
  query
    .mockResolvedValueOnce(company('UA'))
    .mockResolvedValueOnce({ rows: [{ value: '40123456' }] })
    .mockResolvedValueOnce({ rows: [{ value: 365 }] });
  const lookup = vi.fn().mockResolvedValue({
    entity: {
      entity_type: 'UO',
      id: '7',
      edrpou: '40123456',
      name: 'ТОВ "ФАЙН АВТО"',
      short_name: null,
      status: 'зареєстровано',
      registration_date: '2019-04-02',
      termination_date: null,
      director: 'ПЕТРЕНКО ІВАН',
      address: 'Київ',
      published_at: '2026-10-01',
    },
    founders: [],
    contacts: [
      {
        kind: 'phone',
        value: '0443387518',
        normalized_value: '0443387518',
        confidence: 1,
      },
    ],
  });
  const result = await runRegistryMatch({ companyId: 'c' }, 't', lookup);
  expect(result).toMatchObject({ status: 'done', result: { contacts: 1 } });
  const sql = tx.query.mock.calls.map((call) => String(call[0]));
  expect(sql[0]).toBe('begin');
  expect(sql.some((s) => s.includes('delete from company_facts'))).toBe(true);
  expect(sql.some((s) => s.includes('insert into contacts'))).toBe(true);
  expect(sql.at(-1)).toBe('commit');
});

const entity = {
  entity_type: 'FOP' as const,
  id: '7',
  edrpou: null,
  name: 'Петренко Іван Петрович',
  short_name: null,
  status: 'зареєстровано',
  registration_date: null,
  termination_date: null,
  director: null,
  address: 'Київ',
  published_at: null,
};
function prepareMatch(confirm = false) {
  query
    .mockResolvedValueOnce(company('UA'))
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ value: 365 }] });
  const tx = {
    query: vi.fn(async (sql: string) => ({
      rows: confirm && sql.includes('value @>') ? [{}] : [],
    })),
    release: vi.fn(),
  };
  connect.mockResolvedValue(tx);
  return tx;
}
it('binds exactly one active phone match and records its method', async () => {
  const tx = prepareMatch();
  const result = await runRegistryMatch(
    { companyId: 'c' },
    't',
    vi.fn(),
    vi.fn().mockResolvedValue([{ entity, method: 'phone', review: false }]),
  );
  expect(result.status).toBe('done');
  expect(tx.query.mock.calls).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([
        expect.stringContaining('insert into company_facts'),
        expect.arrayContaining(['registry_match_method', '"phone"']),
      ]),
    ]),
  );
});
it.each([
  [
    { entity, method: 'phone', review: false },
    { entity: { ...entity, id: '8' }, method: 'phone', review: false },
  ],
  [{ entity, method: 'fop_initials_address', review: true }],
  [{ entity: { ...entity, status: null }, method: 'phone', review: false }],
])(
  'keeps ambiguous, initial-only, or unknown-status matches for review (%#)',
  async (...candidates) => {
    const tx = prepareMatch();
    const result = await runRegistryMatch(
      { companyId: 'c' },
      't',
      vi.fn(),
      vi.fn().mockResolvedValue(candidates),
    );
    expect(result).toMatchObject({
      status: 'skipped',
      reasonCode: 'registry_candidates',
    });
    expect(
      tx.query.mock.calls.some((call) =>
        call[0].includes('insert into contacts'),
      ),
    ).toBe(false);
  },
);
it('confirms only a current candidate and records the human actor', async () => {
  const tx = prepareMatch(true);
  expect(
    (
      await runRegistryMatch(
        { companyId: 'c', candidate: { type: 'FOP', id: '7' }, actorId: 'u' },
        't',
        vi.fn(),
        vi.fn(),
        vi.fn().mockResolvedValue(entity),
      )
    ).status,
  ).toBe('done');
  expect(tx.query.mock.calls.some((call) => call[0].includes('value @>'))).toBe(
    true,
  );
  const { logActivity } = await import('@sonar/db/tasks');
  expect(logActivity).toHaveBeenCalledWith(
    'registry.candidate.confirmed',
    'company',
    'c',
    'u',
    expect.objectContaining({ method: 'confirmed', entityId: '7' }),
    tx,
  );
});
it('rejects stale candidate confirmation without writing the binding', async () => {
  const tx = prepareMatch();
  expect(
    await runRegistryMatch(
      { companyId: 'c', candidate: { type: 'FOP', id: '7' } },
      't',
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(entity),
    ),
  ).toMatchObject({ reasonCode: 'registry_candidate_stale' });
  expect(
    tx.query.mock.calls.some((call) =>
      call[0].includes('insert into company_facts'),
    ),
  ).toBe(false);
});
