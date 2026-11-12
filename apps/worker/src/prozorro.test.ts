import { describe, expect, it, vi } from 'vitest';
vi.mock('@sonar/db', () => ({ sonarPool: {} }));
vi.mock('@sonar/db/prozorro', () => ({
  saveProzorroPage: vi.fn(),
  matchProzorroCompany: vi.fn(),
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  enqueueProzorroSync: vi.fn(),
  finishEnrichment: vi.fn(),
  TaskFailure: Error,
}));
import { ProzorroHttp, readProzorroFeed } from './prozorro-http.js';
import { syncProzorroPage, type ProzorroProgress } from './prozorro.js';
const config = {
  rate: 5,
  timeoutMs: 1000,
  retries: 2,
  retryDelayMs: 10,
  userAgent: 'SonarBot/test',
};
const id = 'a'.repeat(32);
const doc = {
  data: {
    id,
    tenderID: 'UA-2026-11-12-000001-a',
    dateModified: '2026-11-12T00:00:00Z',
    procuringEntity: { identifier: { id: '12345678', scheme: 'UA-EDR' } },
  },
};
const progress: ProzorroProgress = {
  offset: '',
  documents: 0,
  rows: 0,
  cursorDate: null,
  status: 'queued',
};
describe('Prozorro HTTP and checkpointing', () => {
  it('honors 429 Retry-After, retries 5xx and sends timeout + scanner User-Agent', async () => {
    const wait = vi.fn(async () => {});
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(
      new ProzorroHttp(config, request, wait).get('tenders?limit=1'),
    ).resolves.toEqual({ data: [] });
    expect(wait).toHaveBeenCalledWith(2000);
    expect(wait).toHaveBeenCalledWith(20);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'User-Agent': 'SonarBot/test' },
      signal: expect.any(AbortSignal),
    });
  });
  it('stops after bounded retries and does not retry permanent HTTP failures', async () => {
    for (const status of [403, 503]) {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('', { status }));
      await expect(
        new ProzorroHttp(config, request, async () => {}).get('contracts'),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(request).toHaveBeenCalledTimes(status === 403 ? 1 : 3);
    }
  });
  it('commits a page with its cursor and resumes from that cursor after restart', async () => {
    let persisted = progress;
    const save = vi.fn(async (_docs, _key, next) => {
      persisted = { ...next, rows: 1 } as ProzorroProgress;
      return { ...next, rows: 1 };
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id, dateModified: doc.data.dateModified }],
          next_page: { offset: 'opaque+cursor' },
        }),
      )
      .mockResolvedValueOnce(Response.json(doc));
    await syncProzorroPage(
      'tender',
      persisted,
      100,
      new ProzorroHttp(config, request, async () => {}),
      save,
    );
    expect(persisted).toMatchObject({
      documents: 1,
      rows: 1,
      offset: 'opaque+cursor',
      status: 'running',
    });
    const restarted = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [], next_page: { offset: 'opaque+cursor' } }),
      );
    await syncProzorroPage(
      'tender',
      persisted,
      100,
      new ProzorroHttp(config, restarted, async () => {}),
      save,
    );
    expect(restarted.mock.calls[0]?.[0]).toContain('offset=opaque%2Bcursor');
    expect(persisted).toMatchObject({ documents: 1, rows: 1, status: 'done' });
  });
  it('never advances the cursor after failed documents or a pause', async () => {
    for (const pause of [false, true]) {
      const save = vi.fn();
      const http = {
        get: vi
          .fn()
          .mockResolvedValueOnce({
            data: [{ id, dateModified: doc.data.dateModified }],
            next_page: { offset: 'next' },
          })
          .mockRejectedValueOnce(Error('unavailable')),
      };
      const check = vi.fn(async () => {
        if (pause && check.mock.calls.length === 2) throw Error('paused');
      });
      await expect(
        syncProzorroPage('tender', progress, 100, http, save, check),
      ).rejects.toThrow(pause ? 'paused' : 'unavailable');
      expect(save).not.toHaveBeenCalled();
      expect(progress.offset).toBe('');
    }
  });
  it('rejects invalid feed entries and missing next cursor', () => {
    expect(() => readProzorroFeed({ data: [] })).toThrow();
    expect(() =>
      readProzorroFeed({
        data: [{ id: '../escape', dateModified: 'bad' }],
        next_page: { offset: 'x' },
      }),
    ).toThrow();
  });
});
