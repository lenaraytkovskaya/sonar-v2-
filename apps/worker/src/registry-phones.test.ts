import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  localConnect: vi.fn(),
  sourceConnect: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { connect: mocks.localConnect },
  registryPool: { connect: mocks.sourceConnect },
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  TaskFailure: class extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(code);
    }
  },
}));
import { runRegistryPhoneSync } from './registry-phones.js';

const contact = (id: string, value = '067 123 45 67', kind = 'phone') => ({
  id,
  value,
  kind,
  normalized_value: value,
  entity_type: 'FOP',
  entity_id: '9007199254740999',
  confidence: '0.8500',
});
function setup(rows: ReturnType<typeof contact>[], batchSize = 50000) {
  let saved = {
    cursor: '0',
    scanned: 0,
    indexed: 0,
    estimatedTotal: null,
    status: 'done',
    updatedAt: null,
  };
  let staged = saved;
  const local = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('pg_try_advisory')) return { rows: [{ locked: true }] };
      if (sql.includes('select key,value'))
        return {
          rows: [
            { key: 'registry.phones.batch_size', value: batchSize },
            { key: 'registry.phones.statement_timeout_ms', value: 30000 },
            { key: 'registry.phones.progress', value: saved },
          ],
        };
      if (sql.includes('with saved')) {
        const phones = JSON.parse(values![0] as string);
        return {
          rows: [
            {
              count: new Set(
                phones.map((p: { phone_e164: string }) => p.phone_e164),
              ).size,
            },
          ],
        };
      }
      if (sql.startsWith('update settings'))
        staged = JSON.parse(values![1] as string);
      if (sql === 'commit') saved = staged;
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const source = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('from pg_class'))
        return { rows: [{ count: '16000000' }] };
      if (sql.includes('from public.edr_contacts'))
        return {
          rows: rows
            .filter((r) => BigInt(r.id) > BigInt(values![0] as string))
            .slice(0, batchSize),
        };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  mocks.localConnect.mockResolvedValue(local);
  mocks.sourceConnect.mockResolvedValue(source);
  return { local, source, progress: () => saved };
}
beforeEach(() => vi.clearAllMocks());

it('normalizes UA phones, ignores other kinds and invalid numbers, keeps bigint IDs, and commits progress with the index', async () => {
  const env = setup([
    contact('1'),
    contact('2', 'date 2026-11-12'),
    contact('3', 'mail@example.com', 'email'),
    contact('9007199254740997', '+380671234567'),
  ]);
  expect(await runRegistryPhoneSync()).toMatchObject({
    status: 'done',
    result: {
      cursor: '9007199254740997',
      scanned: 4,
      indexed: 1,
      estimatedTotal: '16000000',
    },
  });
  const write = env.local.query.mock.calls.find(([sql]) =>
    sql.includes('with saved'),
  )!;
  expect(write[1]).toHaveLength(1);
  expect(JSON.parse(write[1]![0] as string)).toEqual([
    {
      phone_e164: '+380671234567',
      entity_type: 'FOP',
      entity_id: '9007199254740999',
      confidence: '0.8500',
    },
    {
      phone_e164: '+380671234567',
      entity_type: 'FOP',
      entity_id: '9007199254740999',
      confidence: '0.8500',
    },
  ]);
  expect(write[0]).toContain('group by phone_e164,entity_type,entity_id');
  const localSql = env.local.query.mock.calls.map(([sql]) => sql);
  expect(localSql.indexOf('begin')).toBeLessThan(localSql.indexOf(write[0]));
  expect(localSql.indexOf('commit')).toBeGreaterThan(
    localSql.findIndex((sql) => sql.startsWith('update settings')),
  );
  expect(env.source.query.mock.calls.map(([sql]) => sql)).toContain(
    'begin read only',
  );
  expect(
    env.source.query.mock.calls.some(([sql]) =>
      /insert|update|delete|offset|count\(\*\)/i.test(sql),
    ),
  ).toBe(false);
  expect(env.source.query).toHaveBeenCalledWith(
    "select set_config('statement_timeout',$1,true)",
    ['30000'],
  );
  expect(env.local.release).toHaveBeenCalledWith(false);
});

it('resumes from the last committed batch after a source timeout', async () => {
  const env = setup(
    [contact('1'), contact('2', 'invalid'), contact('3', '050 123 45 67')],
    2,
  );
  const read = env.source.query.getMockImplementation()!;
  let fail = true;
  env.source.query.mockImplementation(async (sql, values) => {
    if (
      fail &&
      sql.includes('from public.edr_contacts') &&
      values?.[0] === '2'
    ) {
      fail = false;
      throw new Error('statement timeout');
    }
    return read(sql, values);
  });
  await expect(runRegistryPhoneSync()).rejects.toMatchObject({
    code: 'registry_phone_sync_failed',
  });
  expect(env.progress()).toMatchObject({ cursor: '2', scanned: 2, indexed: 1 });
  expect(env.source.query).toHaveBeenCalledWith('rollback');
  await expect(runRegistryPhoneSync()).resolves.toMatchObject({
    status: 'done',
    result: { cursor: '3', scanned: 3, indexed: 2 },
  });
});

it('rolls back the index and cursor together on persistence failure', async () => {
  const env = setup([contact('1')]);
  const query = env.local.query.getMockImplementation()!;
  env.local.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith('update settings')) throw new Error('write failed');
    return query(sql, values);
  });
  await expect(runRegistryPhoneSync()).rejects.toMatchObject({
    code: 'registry_phone_sync_failed',
  });
  expect(env.progress()).toMatchObject({ cursor: '0', scanned: 0, indexed: 0 });
  expect(env.local.query).toHaveBeenCalledWith('rollback');
  expect(
    env.local.query.mock.calls.some(([sql]) =>
      sql.includes('pg_advisory_unlock'),
    ),
  ).toBe(true);
});

it('skips concurrent syncs without reading registry or unlocking another worker', async () => {
  const env = setup([]);
  env.local.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
  await expect(runRegistryPhoneSync()).resolves.toMatchObject({
    status: 'skipped',
    reasonCode: 'registry_sync_running',
  });
  expect(mocks.sourceConnect).not.toHaveBeenCalled();
  expect(env.local.query).toHaveBeenCalledOnce();
});

it('indexes telephone aliases and skips unsupported entity types', async () => {
  const env = setup([
    contact('1', '0671234567', 'telephone'),
    contact('2', '0501234567', 'телефон'),
    { ...contact('3'), entity_type: 'unknown' },
  ]);
  await expect(runRegistryPhoneSync()).resolves.toMatchObject({
    result: { scanned: 3, indexed: 2 },
  });
  const write = env.local.query.mock.calls.find(([sql]) =>
    sql.includes('with saved'),
  )!;
  expect(JSON.parse(write[1]![0] as string)).toHaveLength(2);
});

it('uses one JSON parameter for a full 50,000-contact batch and resumes by ID', async () => {
  const env = setup(
    Array.from({ length: 50000 }, (_, i) => contact(String(i + 1))),
  );
  await expect(runRegistryPhoneSync()).resolves.toMatchObject({
    status: 'done',
    result: { scanned: 50000, cursor: '50000' },
  });
  const write = env.local.query.mock.calls.find(([sql]) =>
    sql.includes('with saved'),
  )!;
  expect(write[1]).toHaveLength(1);
  expect(JSON.parse(write[1]![0] as string)).toHaveLength(50000);
  expect(env.source.query).toHaveBeenCalledWith(
    expect.stringContaining('where c.id>$1::bigint order by c.id limit $2'),
    ['50000', 50000],
  );
});
