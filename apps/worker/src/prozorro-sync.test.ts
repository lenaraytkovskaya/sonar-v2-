import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  statfs: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  locked: true,
  enabled: true,
  progress: {
    offset: 'checkpoint',
    documents: 12,
    rows: 24,
    cursorDate: '2026-11-01T00:00:00Z',
    status: 'running',
  },
}));
vi.mock('@sonar/db', () => ({
  sonarPool: {
    connect: async () => ({ query: state.query, release: state.release }),
  },
}));
vi.mock('@sonar/db/prozorro', () => ({
  saveProzorroPage: state.save,
  matchProzorroCompany: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ statfs: state.statfs }));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  enqueueProzorroSync: vi.fn(),
  finishEnrichment: vi.fn(),
  TaskFailure: class extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(code);
    }
  },
}));
vi.mock('./prozorro-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prozorro-http.js')>()),
  ProzorroHttp: class {
    get = state.get;
  },
}));
import { runProzorroSync } from './prozorro.js';
const settings: Record<string, unknown> = {
  'prozorro.rate_per_second': 5,
  'prozorro.timeout_ms': 30000,
  'prozorro.max_retries': 4,
  'prozorro.retry_delay_ms': 1000,
  'prozorro.disk_path': '/host-disk',
  'prozorro.min_free_bytes': 5000,
  'prozorro.min_free_ratio': 0.1,
  'prozorro.page_size': 100,
  'scanner.user_agent': 'SonarBot/test',
};
beforeEach(() => {
  vi.clearAllMocks();
  state.locked = true;
  state.enabled = true;
  state.progress = {
    offset: 'checkpoint',
    documents: 12,
    rows: 24,
    cursorDate: '2026-11-01T00:00:00Z',
    status: 'running',
  };
  state.statfs.mockResolvedValue({ bavail: 1000, bsize: 1000, blocks: 2000 });
  state.query.mockImplementation(
    async (sql: string, values: unknown[] = []) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ locked: state.locked }] };
      if (sql.includes("where key like 'prozorro.%'"))
        return {
          rows: Object.entries({
            ...settings,
            'prozorro.tender.progress': state.progress,
          }).map(([key, value]) => ({ key, value })),
        };
      if (
        sql.includes("select value from settings where key='prozorro.enabled'")
      )
        return { rows: [{ value: state.enabled }] };
      if (sql.includes('set value=value||jsonb_build_object')) {
        state.progress = { ...state.progress, status: String(values[1]) };
        return { rows: [] };
      }
      return { rows: [] };
    },
  );
});
it('pauses before network work on low bytes or low free ratio and preserves checkpoint', async () => {
  for (const disk of [
    { bavail: 1, bsize: 1000, blocks: 2 },
    { bavail: 10, bsize: 1000, blocks: 1000 },
  ]) {
    state.statfs.mockResolvedValue(disk);
    await expect(runProzorroSync({ feed: 'tender' })).resolves.toMatchObject({
      status: 'paused',
      reasonCode: 'prozorro_paused',
      reasonUk: expect.stringContaining('місця'),
    });
    expect(state.progress).toMatchObject({
      offset: 'checkpoint',
      documents: 12,
      rows: 24,
      status: 'paused',
    });
  }
  expect(state.get).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(
    state.query.mock.calls.some(([sql]) => sql.includes("set value='false'")),
  ).toBe(true);
  expect(state.release).toHaveBeenCalledWith(false);
});
it('honors disabled flag without disk or HTTP access', async () => {
  state.enabled = false;
  await expect(runProzorroSync({ feed: 'tender' })).resolves.toMatchObject({
    status: 'paused',
    reasonUk: expect.stringContaining('користувачем'),
  });
  expect(state.statfs).not.toHaveBeenCalled();
  expect(state.get).not.toHaveBeenCalled();
});
it('skips an advisory-locked feed without modifying progress or unlocking another owner', async () => {
  state.locked = false;
  await expect(runProzorroSync({ feed: 'tender' })).resolves.toMatchObject({
    status: 'skipped',
    reasonCode: 'prozorro_busy',
  });
  expect(state.query).toHaveBeenCalledTimes(1);
  expect(state.release).toHaveBeenCalledWith(false);
  expect(state.get).not.toHaveBeenCalled();
  expect(state.progress.status).toBe('running');
});
it('marks HTTP failure without overwriting offset, totals or cursor date, then releases its lock', async () => {
  state.get.mockRejectedValueOnce(Error('network offline'));
  await expect(runProzorroSync({ feed: 'tender' })).rejects.toMatchObject({
    code: 'prozorro_sync_failed',
  });
  expect(state.progress).toEqual({
    offset: 'checkpoint',
    documents: 12,
    rows: 24,
    cursorDate: '2026-11-01T00:00:00Z',
    status: 'failed',
  });
  const update = state.query.mock.calls.find(([sql]) =>
    sql.includes('set value=value||jsonb_build_object'),
  );
  expect(update?.[1]).toEqual([
    'prozorro.tender.progress',
    'failed',
    expect.any(String),
  ]);
  expect(
    state.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock')),
  ).toBe(true);
  expect(state.save).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledWith(false);
});
it('pauses safely when the host filesystem cannot be inspected', async () => {
  state.statfs.mockRejectedValueOnce(Error('missing mount'));
  await expect(runProzorroSync({ feed: 'tender' })).resolves.toMatchObject({
    status: 'paused',
    reasonUk: expect.stringContaining('перевірити'),
  });
  expect(state.get).not.toHaveBeenCalled();
  expect(state.progress.offset).toBe('checkpoint');
});
