import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  ids: new Map<string, string>(),
  facts: [] as { source: string; value: unknown }[],
}));
vi.mock('./index.js', () => ({
  sonarPool: {
    connect: async () => ({ query: state.query, release: state.release }),
    query: state.query,
  },
}));
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on() {}
    start = state.start;
    send = state.send;
  },
}));
import { enqueueProzorroCompany, enqueueProzorroLookup } from './tasks.js';
import {
  prozorroCompanyCode,
  prozorroCompanyCodes,
  saveProzorroCompanySnapshot,
} from './prozorro.js';
beforeEach(() => {
  vi.clearAllMocks();
  state.ids.clear();
  state.facts = [{ source: 'registry', value: '12345678' }];
  state.start.mockResolvedValue(undefined);
  state.query.mockImplementation(
    async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('select value,source')) return { rows: state.facts };
      if (sql.includes('pg_try_advisory_xact_lock'))
        return { rows: [{ locked: true }] };
      if (sql.startsWith('insert into company_facts')) {
        state.facts.push({
          source: 'manual',
          value: JSON.parse(String(values[1])),
        });
        return { rows: [] };
      }
      if (sql.startsWith('insert into tasks')) {
        const key = String(values[1]);
        if (state.ids.has(key)) return { rows: [] };
        state.ids.set(key, 'task-id');
        return { rows: [{ id: 'task-id' }] };
      }
      if (sql === 'select id,status from tasks where idempotency_key=$1')
        return {
          rows: [{ id: state.ids.get(String(values[0])), status: 'queued' }],
        };
      if (sql === 'select value from settings where key=$1')
        return {
          rows: [
            { value: { retryLimit: 0, retryDelay: 60, expireInSeconds: 900 } },
          ],
        };
      return { rows: [] };
    },
  );
});

it('does not enqueue automatic external work when disabled or registry was not successful', async () => {
  // finishEnrichment reads campaign memberships; empty rows keep it local and free.
  await enqueueProzorroLookup('company');
  expect(state.send).not.toHaveBeenCalled();
});
it('chooses the authoritative registry code, rejects conflicting/masked identities', async () => {
  state.query.mockResolvedValue({
    rows: [
      { source: 'website', value: '99999999' },
      { source: 'registry', value: '41165490' },
    ],
  });
  expect(await prozorroCompanyCode('company')).toBe('41165490');
  state.query.mockResolvedValue({
    rows: [
      { source: 'website', value: '1234****' },
      { source: 'website', value: { code: '12345678', valid: false } },
    ],
  });
  expect(await prozorroCompanyCode('company')).toBeNull();
  state.query.mockResolvedValue({
    rows: [
      { source: 'manual', value: '12345678' },
      { source: 'website', value: '87654321' },
    ],
  });
  expect(await prozorroCompanyCode('company')).toBeNull();
});
it('persists one snapshot and deduplicates contacts with normalized conflict keys in a transaction', async () => {
  const contact = {
    kind: 'phone',
    value: '+380501234567',
    sourceUrl: 'https://prozorro.gov.ua/tender/UA-2026-01-01-000001-a',
    date: '2026-01-01T00:00:00Z',
  };
  await saveProzorroCompanySnapshot('company', {
    code: '12345678',
    checkedAt: '2026-11-14T00:00:00Z',
    tenders: [{ contacts: [contact] }],
  } as never);
  expect(state.query.mock.calls[0]?.[0]).toBe('begin');
  expect(
    state.query.mock.calls.some(([sql]) =>
      sql.includes('on conflict(company_id,kind,normalized)'),
    ),
  ).toBe(true);
  expect(state.query.mock.calls.at(-1)?.[0]).toBe('commit');
  expect(state.release).toHaveBeenCalled();
});

it('reports pending work when another producer holds the company lock before its insert is visible', async () => {
  state.query.mockResolvedValue({ rows: [] });
  expect(await enqueueProzorroCompany('company')).toEqual({
    id: null,
    status: 'queued',
    created: false,
  });
  expect(state.send).not.toHaveBeenCalled();
});

it('saves a known manual code before dispatch, with provenance, and never duplicates or overwrites a fact', async () => {
  state.facts = [];
  await enqueueProzorroCompany('company', null, undefined, {
    manualCode: '41165490',
  });
  expect(state.facts).toEqual([{ source: 'manual', value: '41165490' }]);
  const inserts = () =>
    state.query.mock.calls.filter(([sql]) =>
      sql.startsWith('insert into company_facts'),
    );
  expect(inserts()).toEqual([
    [
      expect.stringContaining("'manual',$3,now()"),
      ['company', '"41165490"', '/companies/company'],
    ],
  ]);
  expect(state.send).toHaveBeenCalledTimes(1);
  const writes = state.query.mock.calls.map(([sql]) => sql);
  expect(
    writes.indexOf('select id from companies where id=$1 for update'),
  ).toBeLessThan(writes.indexOf(inserts()[0]![0]));
  await enqueueProzorroCompany('company', null, undefined, {
    manualCode: '41165490',
  });
  expect(inserts()).toHaveLength(1);
  expect(state.send).toHaveBeenCalledTimes(1);
});
it.each(['1234****', '', '1234567', '12345678901'])(
  'rejects invalid manual code %s before any mutation',
  async (manualCode) => {
    await expect(
      enqueueProzorroCompany('company', null, undefined, { manualCode }),
    ).rejects.toMatchObject({ reason: 'invalidCode' });
    expect(state.query).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  },
);
it('rejects a different trusted identity and rolls back without dispatch or replacing provenance', async () => {
  await expect(
    enqueueProzorroCompany('company', null, undefined, {
      manualCode: '41165490',
    }),
  ).rejects.toMatchObject({ reason: 'conflictingCode' });
  expect(state.facts).toEqual([{ source: 'registry', value: '12345678' }]);
  expect(state.query.mock.calls.at(-1)?.[0]).toBe('rollback');
  expect(state.send).not.toHaveBeenCalled();
});
it('does not add a manual fact when the same code already has trusted provenance', async () => {
  await enqueueProzorroCompany('company', null, undefined, {
    manualCode: '12345678',
  });
  expect(state.facts).toEqual([{ source: 'registry', value: '12345678' }]);
});
it('explicitly rejects a busy manual action without claiming its code was saved', async () => {
  state.query.mockResolvedValue({ rows: [] });
  await expect(
    enqueueProzorroCompany('company', null, undefined, {
      manualCode: '41165490',
    }),
  ).rejects.toMatchObject({ reason: 'companyBusy' });
  expect(state.send).not.toHaveBeenCalled();
  expect(state.query.mock.calls.at(-1)?.[0]).toBe('rollback');
});

it.each([
  { facts: [], allowed: true },
  { facts: [{ source: 'manual', value: '41165490' }], allowed: false },
  {
    facts: [{ source: 'registry', value: { code: '12345678' } }],
    allowed: false,
  },
  {
    facts: [{ source: 'website', value: { code: '12345678', valid: false } }],
    allowed: true,
  },
  {
    facts: [
      { source: 'manual', value: '12345678' },
      { source: 'website', value: '87654321' },
    ],
    allowed: false,
  },
])('offers entry only for missing code: $facts', async ({ facts, allowed }) => {
  state.facts = facts;
  expect(
    !(await prozorroCompanyCodes('company')).some((fact) => fact.code),
  ).toBe(allowed);
});
it('preserves invalid registry authority instead of falling back to an unverified code', async () => {
  state.facts = [
    { source: 'registry', value: { code: '12345678', valid: false } },
    { source: 'website', value: '87654321' },
  ];
  expect(await prozorroCompanyCode('company')).toBeNull();
});
it('keeps ordinary no-code lookups empty and ready for the existing worker skip', async () => {
  state.facts = [];
  await enqueueProzorroCompany('company');
  expect(state.facts).toEqual([]);
  expect(
    state.query.mock.calls.find(([sql]) =>
      sql.startsWith('insert into tasks'),
    )?.[1]?.[2],
  ).toMatchObject({ code: null });
});
it('rolls back the transaction when dispatch fails after the manual fact insert', async () => {
  state.facts = [];
  state.send.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(
    enqueueProzorroCompany('company', null, undefined, {
      manualCode: '41165490',
    }),
  ).rejects.toThrow('queue unavailable');
  expect(state.query.mock.calls.at(-1)?.[0]).toBe('rollback');
  expect(state.query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false);
});
