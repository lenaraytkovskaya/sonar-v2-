import { beforeEach, expect, it, vi } from 'vitest';
const { query, connect } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { query, connect },
  registryPool: {},
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
beforeEach(() => vi.clearAllMocks());
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
it('skips when the website gave no valid code', async () => {
  query.mockResolvedValueOnce(company(null)).mockResolvedValueOnce({
    rows: [{ value: { code: '1234', valid: false } }],
  });
  const lookup = vi.fn();
  await expect(
    runRegistryMatch({ companyId: 'c' }, 't', lookup),
  ).resolves.toMatchObject({ reasonCode: 'registry_code_missing' });
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
  expect(sql[1]).toContain('delete from company_facts');
  expect(sql.some((s) => s.includes('insert into contacts'))).toBe(true);
  expect(sql.at(-1)).toBe('commit');
});
