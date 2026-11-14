import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  ids: new Map<string, string>(),
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
import {
  enqueueProzorroCompany,
  enqueueCampaignProzorro,
  enqueueProzorroLookup,
} from './tasks.js';
import {
  prozorroCompanyCode,
  saveProzorroCompanySnapshot,
} from './prozorro.js';
beforeEach(() => {
  vi.clearAllMocks();
  state.ids.clear();
  state.start.mockResolvedValue(undefined);
  state.query.mockImplementation(
    async (sql: string, values: unknown[] = []) => {
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
it('atomically deduplicates company/day and sends pg-boss only once', async () => {
  const first = await enqueueProzorroCompany('company', 'actor');
  const second = await enqueueProzorroCompany('company', 'actor');
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(state.send).toHaveBeenCalledTimes(1);
  expect([...state.ids.keys()][0]).toMatch(
    /^prozorro\.company:company:\d{4}-\d{2}-\d{2}$/,
  );
  expect(
    state.query.mock.calls.some(([sql]) =>
      sql.includes("subject_type='company'"),
    ),
  ).toBe(true);
});
it('bulk query excludes successful checks in the last 30 days and counts only new tasks', async () => {
  const base = state.query.getMockImplementation()!;
  state.query.mockImplementation((sql: string, values: unknown[]) =>
    sql.includes('select distinct cc.company_id')
      ? Promise.resolve({ rows: [{ company_id: 'company' }] })
      : base(sql, values),
  );
  expect(await enqueueCampaignProzorro('campaign', 'actor')).toBe(1);
  expect(await enqueueCampaignProzorro('campaign', 'actor')).toBe(0);
  expect(
    state.query.mock.calls.find(([sql]) =>
      sql.includes('select distinct cc.company_id'),
    )?.[0],
  ).toContain("interval '30 days'");
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
it('resumes the same daily task after missing EDR is resolved, without changing its idempotency key', async () => {
  const base = state.query.getMockImplementation()!;
  await enqueueProzorroCompany('company');
  state.send.mockClear();
  state.query.mockImplementation((sql: string, values: unknown[]) => {
    if (sql.startsWith('select payload from tasks'))
      return Promise.resolve({ rows: [{ payload: { companyId: 'company' } }] });
    if (sql.includes('select value,source from company_facts'))
      return Promise.resolve({
        rows: [{ source: 'registry', value: '12345678' }],
      });
    if (sql.startsWith("update tasks set status='queued'"))
      return Promise.resolve({ rows: [{ id: 'task-id' }] });
    return base(sql, values);
  });
  expect((await enqueueProzorroCompany('company')).created).toBe(true);
  expect(state.ids.size).toBe(1);
  expect(state.send).toHaveBeenCalledTimes(1);
});
