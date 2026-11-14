import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  query: vi.fn(),
  code: vi.fn(),
  save: vi.fn(),
  http: vi.fn(),
  reconcile: vi.fn(),
  createQueue: vi.fn(),
  work: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { query: state.query } }));
vi.mock('@sonar/db/prozorro', () => ({
  prozorroCompanyCode: state.code,
  saveProzorroCompanySnapshot: state.save,
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {
    createQueue: state.createQueue,
    work: state.work,
    schedule: state.schedule,
  },
  reconcileProzorroCompanyTasks: state.reconcile,
  enqueueProzorroCompany: vi.fn(),
  runTask: vi.fn(),
  finishEnrichment: vi.fn(),
}));
vi.mock('./prozorro-http.js', async (original) => ({
  ...(await original<typeof import('./prozorro-http.js')>()),
  sharedProzorroHttp: state.http,
}));
import {
  lookupProzorroCompany,
  readCompanySearch,
  runProzorroCompany,
  registerProzorroCompanyTasks,
} from './prozorro-company.js';
import { ProzorroHttp, ProzorroHttpError } from './prozorro-http.js';
import { extractCompanyTender, summarizeCompanyTenders } from '@sonar/core';
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/prozorro-company.json', import.meta.url),
    'utf8',
  ),
);
const now = new Date('2026-11-14T12:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  state.save.mockResolvedValue(true);
  state.code.mockResolvedValue('41165490');
  state.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('select key,value')
      ? Object.entries({
          'prozorro.rate_per_second': 5,
          'prozorro.timeout_ms': 1000,
          'prozorro.max_retries': 2,
          'prozorro.retry_delay_ms': 10,
          'prozorro.company.months': 12,
          'prozorro.company.max_tenders': 5,
          'prozorro.company.max_search_pages': 10,
          'scanner.user_agent': 'SonarBot/test',
        }).map(([key, value]) => ({ key, value }))
      : [{ value: true }],
  }));
});
it('uses captured POST/query and resolves UUID before verified official detail, never substitutes tenderID', async () => {
  const search = { ...fixture.search, data: [fixture.search.data[1]] };
  const http = {
    search: vi.fn().mockResolvedValue(search),
    summary: vi.fn().mockResolvedValue(fixture.summary),
    get: vi.fn().mockResolvedValue(fixture.detail),
  };
  const result = await lookupProzorroCompany(
    '41165490',
    12,
    5,
    http,
    undefined,
    now,
  );
  expect(http.search.mock.calls[0]![0].get('tenderer[0]')).toBe('41165490');
  expect(http.search.mock.calls[0]![0].get('sort_by')).toBe('dateCreated');
  expect(http.get).toHaveBeenCalledWith(`tenders/${fixture.summary.id}`);
  expect(result).toMatchObject({
    searchTotal: 79,
    inspected: 1,
    matched: 1,
    wins: 1,
    wonAmounts: { UAH: 5297.1 },
    coverage: 'sample',
  });
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(search));
  await new ProzorroHttp(
    {
      rate: 5,
      timeoutMs: 1000,
      retries: 0,
      retryDelayMs: 10,
      userAgent: 'SonarBot/test',
    },
    request,
    async () => {},
  ).search(new URLSearchParams({ 'tenderer[0]': '41165490' }));
  expect(request.mock.calls[0]).toMatchObject([
    'https://prozorro.gov.ua/api/search/tenders?tenderer%5B0%5D=41165490',
    { method: 'POST' },
  ]);
  expect(request.mock.calls[0]![1]?.body).toBeUndefined();
});
it('bounds detail lookups to newest five, deduplicates ids and rejects resolver/detail identity mismatches', async () => {
  const data = Array.from({ length: 8 }, (_, i) => ({
    tenderID: `UA-2026-11-0${8 - i}-000001-a`,
  }));
  const http = {
    search: vi.fn().mockResolvedValue({ ...fixture.search, data }),
    summary: vi
      .fn()
      .mockResolvedValue({ ...fixture.summary, tenderID: data[0]!.tenderID }),
    get: vi.fn().mockResolvedValue({
      data: { ...fixture.detail.data, tenderID: data[0]!.tenderID },
    }),
  };
  http.summary.mockImplementation(async (id: string) => ({
    ...fixture.summary,
    tenderID: id,
  }));
  http.get.mockImplementation(async () => ({
    data: {
      ...fixture.detail.data,
      tenderID: http.summary.mock.calls.at(-1)![0],
    },
  }));
  const result = await lookupProzorroCompany(
    '41165490',
    12,
    5,
    http,
    undefined,
    now,
  );
  expect(http.get).toHaveBeenCalledTimes(5);
  expect(result.inspected).toBe(5);
  http.summary.mockResolvedValue({
    ...fixture.summary,
    tenderID: 'UA-2020-01-01-000001-a',
  });
  expect(
    await lookupProzorroCompany('41165490', 12, 5, http, undefined, now),
  ).toMatchObject({ resolverRejected: 8, inspected: 0, matched: 0 });
  http.summary.mockResolvedValue({
    ...fixture.summary,
    tenderID: data[0]!.tenderID,
  });
  http.get.mockResolvedValue(fixture.detail);
  expect(
    await lookupProzorroCompany('41165490', 12, 5, http, undefined, now),
  ).toMatchObject({ invalidDetails: 1, matched: 0 });
});
it('matches exact UA-EDR across bids/awards/contracts, normalizes contacts and excludes buyer-only matches', () => {
  const d = structuredClone(fixture.detail.data);
  d.awards = [];
  d.contracts = [];
  const party = {
    identifier: { scheme: 'UA-EDR', id: '41165490' },
    contactPoint: {
      name: 'Test Contact',
      telephone: '050 123 45 67',
      email: 'TEST@example.com',
    },
  };
  d.bids = [
    {
      date: '2026-09-10T00:00:00Z',
      tenderers: [
        party,
        party,
        { ...party, identifier: { scheme: 'UA-EDR', id: '41165491' } },
      ],
    },
  ];
  const tender = extractCompanyTender({ data: d }, '41165490')!;
  expect(tender.contacts.map((c) => c.value)).toEqual([
    'Test Contact',
    '+380501234567',
    'test@example.com',
  ]);
  expect(tender.winner).toBe(false);
  d.bids = [];
  d.procuringEntity = party;
  expect(extractCompanyTender({ data: d }, '41165490')).toBeNull();
  d.contracts = [
    {
      id: 'contract-only',
      status: 'active',
      dateSigned: d.date,
      suppliers: [party],
      value: { amount: 10, currency: 'EUR' },
    },
  ];
  expect(extractCompanyTender({ data: d }, '41165490')).toMatchObject({
    winner: true,
    wonAmounts: { EUR: 10 },
  });
  party.identifier.scheme = 'UA-IPN';
  expect(extractCompanyTender({ data: d }, '41165490')).toBeNull();
});
it('counts active awards once per tender, contracts replace awards, canceled awards cannot win and currencies stay separate', () => {
  const d = structuredClone(fixture.detail.data),
    a = d.awards[0];
  d.awards.push({
    ...structuredClone(a),
    id: 'other',
    value: { amount: 20, currency: 'EUR' },
  });
  d.contracts.push({
    ...d.contracts[0],
    id: 'amendment',
    dateSigned: '2026-09-12T00:00:00Z',
  });
  let t = extractCompanyTender({ data: d }, '41165490')!;
  expect(t.wonAmounts).toEqual({ UAH: 5297.1, EUR: 20 });
  expect(summarizeCompanyTenders([t, t])).toMatchObject({
    matched: 1,
    wins: 1,
    wonAmounts: { UAH: 5297.1, EUR: 20 },
  });
  d.awards.forEach((x: { status: string }) => (x.status = 'cancelled'));
  t = extractCompanyTender({ data: d }, '41165490')!;
  expect(t.winner).toBe(false);
  expect(t.wonAmounts).toEqual({});
});
it('skips missing EDR without external requests, pauses when disabled and stores no spend events', async () => {
  state.code.mockResolvedValue(null);
  expect(await runProzorroCompany({ companyId: 'company' })).toEqual({
    status: 'skipped',
    reasonCode: 'prozorro_missing_edrpou',
    reasonUk: 'Немає коду ЄДРПОУ',
  });
  expect(state.http).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  state.query.mockResolvedValue({ rows: [{ value: false }] });
  expect(await runProzorroCompany({ companyId: 'company' })).toMatchObject({
    status: 'paused',
  });
  expect(
    state.query.mock.calls.some(([sql]) => sql.includes('spend_events')),
  ).toBe(false);
});
it('maps exhausted 429/5xx to paused and permanent 4xx to readable failed outcomes', async () => {
  for (const status of [429, 503, 403]) {
    state.http.mockReturnValue({
      search: vi.fn().mockRejectedValue(new ProzorroHttpError(status)),
    });
    expect(await runProzorroCompany({ companyId: 'company' })).toMatchObject({
      status: status === 403 ? 'failed' : 'paused',
      reasonCode: `prozorro_http_${status}`,
      reasonUk: expect.stringContaining('Prozorro'),
    });
  }
  expect(state.save).not.toHaveBeenCalled();
});
it('rejects malformed search responses instead of saving a successful empty snapshot', () => {
  for (const raw of [
    {},
    { ...fixture.search, total: '79' },
    { ...fixture.search, data: {} },
  ])
    expect(() => readCompanySearch(raw)).toThrow();
});

it('uses observed one-based pagination after default page zero and counts the period separately from five details', async () => {
  const search = vi
    .fn()
    .mockResolvedValueOnce(fixture.search)
    .mockResolvedValueOnce(fixture.pagination[0].response)
    .mockResolvedValueOnce({
      ...fixture.pagination[0].response,
      page: 3,
      data: [],
      total: 79,
    });
  const http = {
    search,
    summary: vi.fn().mockResolvedValue(fixture.summary),
    get: vi.fn().mockResolvedValue(fixture.detail),
  };
  const result = await lookupProzorroCompany(
    '41165490',
    12,
    5,
    http,
    undefined,
    now,
    3,
  );
  expect(search.mock.calls[0]![0].get('page')).toBeNull();
  expect(search.mock.calls[1]![0].get('page')).toBe('2');
  expect(search.mock.calls[2]![0].get('page')).toBe('3');
  expect(result).toMatchObject({
    periodParticipationCount: 15,
    periodCountExact: false,
    searchPages: 3,
    searchTotal: 79,
  });
  expect(http.get.mock.calls.length).toBeLessThanOrEqual(5);
});
it('claims an exact search-period count only after full, stable, deduplicated traversal', async () => {
  const data = fixture.search.data.slice(0, 3);
  const http = {
    search: vi
      .fn()
      .mockResolvedValue({ data, total: 3, page: 0, per_page: 20 }),
    summary: vi.fn().mockResolvedValue(fixture.summary),
    get: vi.fn().mockResolvedValue(fixture.detail),
  };
  expect(
    await lookupProzorroCompany('41165490', 12, 5, http, undefined, now),
  ).toMatchObject({ periodParticipationCount: 3, periodCountExact: true });
  for (const rows of [
    [...data, data[0]],
    [...data, { tenderID: 'invalid' }],
    [...data].reverse(),
    [
      ...data,
      {
        tenderID: 'UA-2026-08-01-000001-a',
        dateCreated: '2026-09-01T00:00:00Z',
      },
    ],
  ]) {
    http.search.mockResolvedValue({
      data: rows,
      total: rows.length,
      page: 0,
      per_page: 20,
    });
    expect(
      (await lookupProzorroCompany('41165490', 12, 5, http, undefined, now))
        .periodCountExact,
    ).toBe(false);
  }
});
it('respects configured page budget, portal cap and skips invalid resolvers without consuming detail budget', async () => {
  const first = { ...fixture.search, total: 1000 };
  const http = {
    search: vi.fn().mockResolvedValue(first),
    summary: vi.fn().mockResolvedValue(fixture.summary),
    get: vi.fn().mockResolvedValue(fixture.detail),
  };
  const result = await lookupProzorroCompany(
    '41165490',
    12,
    5,
    http,
    undefined,
    now,
    1,
  );
  expect(http.search).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    searchTotalCapped: true,
    periodCountExact: false,
    searchPages: 1,
  });
  expect(http.get).toHaveBeenCalledTimes(1);
  expect(result.resolverRejected).toBe(14);
});

it('rejects a queued identity that has already changed before any HTTP request', async () => {
  expect(
    await runProzorroCompany({ companyId: 'company', code: '12345678' }),
  ).toMatchObject({
    status: 'skipped',
    reasonCode: 'prozorro_identity_changed',
  });
  expect(state.http).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
it('does not report done when the atomic save rejects an identity changed during HTTP', async () => {
  state.http.mockReturnValue({
    search: vi
      .fn()
      .mockResolvedValue({ ...fixture.search, data: [fixture.search.data[1]] }),
    summary: vi.fn().mockResolvedValue(fixture.summary),
    get: vi.fn().mockResolvedValue(fixture.detail),
  });
  state.save.mockResolvedValue(false);
  expect(
    await runProzorroCompany({ companyId: 'company', code: '41165490' }),
  ).toMatchObject({
    status: 'skipped',
    reasonCode: 'prozorro_identity_changed',
  });
  expect(state.save).toHaveBeenCalledWith(
    'company',
    expect.objectContaining({ code: '41165490' }),
  );
});
it('reconciles company jobs on startup and each scheduler trigger', async () => {
  await registerProzorroCompanyTasks();
  expect(state.reconcile).toHaveBeenCalledTimes(1);
  expect(state.schedule).toHaveBeenCalledWith(
    'prozorro.company.reconcile',
    '* * * * *',
  );
  await state.work.mock.calls[0]![1]();
  expect(state.reconcile).toHaveBeenCalledTimes(2);
});
