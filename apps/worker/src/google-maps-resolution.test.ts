import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@sonar/db/email', () => ({
  transaction: async (fn: (c: { query: typeof query }) => unknown) =>
    fn({ query }),
}));
vi.mock('@sonar/db/tasks', () => ({
  TaskFailure: class extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(code);
    }
  },
}));
import { readGoogleBody, resolveGoogleMaps } from './google-maps-resolution.js';
const placeId = 'ChIJSyntheticResolvedPlace01';
const input = {
  companyId: 'company',
  campaignId: 'campaign',
  sourceUrl: 'https://maps.app.goo.gl/SyntheticShare',
};
const limits = { timeoutMs: 100, maxBytes: 1024, priceUsd: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GOOGLE_PLACES_API_KEY', 'synthetic-key');
  query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('insert into tasks') ? [{ id: 'receipt' }] : [],
  }));
});
afterEach(() => vi.unstubAllEnvs());
it.each([
  'https://maps.app.goo.gl/SyntheticShare?g_st=ic',
  'https://www.google.com/maps/place/Company/data=!1s0x123:0x456',
])('uses the documented fixed API contract for %s', async (sourceUrl) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ entities: [{ place: `places/${placeId}` }] }),
    );
  expect(
    await resolveGoogleMaps({ ...input, sourceUrl }, 'parent', limits, fetcher),
  ).toEqual({ placeId, receiptId: 'receipt' });
  expect(fetcher).toHaveBeenCalledWith(
    'https://mapstools.googleapis.com/v1:resolveMapsUrls',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': 'synthetic-key',
      },
      body: JSON.stringify({ urls: [sourceUrl] }),
    }),
  );
  expect(
    query.mock.calls.find(([sql]) =>
      sql.startsWith('insert into spend_events'),
    )?.[1],
  ).toEqual([
    0,
    'receipt',
    expect.objectContaining({
      operation: 'resolveMapsUrls',
      costBasis: 'documented_free_sku',
    }),
  ]);
});
it.each([403, 429, 503])(
  'records an honest zero-cost HTTP %s failure',
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status }));
    await expect(
      resolveGoogleMaps(input, 'parent', limits, fetcher),
    ).rejects.toMatchObject({
      code:
        status === 403 ? 'google_resolve_activation' : 'google_resolve_http',
      reasonUk: expect.stringMatching(
        status === 403 ? /Maps Experience agent tools API/ : /Повторіть/,
      ),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.find(([sql]) =>
        sql.startsWith('insert into spend_events'),
      )?.[1]?.[0],
    ).toBe(0);
  },
);
it.each([
  [
    { entities: [{}], failedRequests: { 0: { code: 3 } } },
    'google_resolve_no_place',
  ],
  [
    { entities: [{}], failedRequests: { 0: { code: 13 } } },
    'google_resolve_internal',
  ],
  [{ entities: [{}] }, 'google_resolve_no_place'],
  [
    { entities: [{ place: `places/${placeId}` }, { place: 'places/Other' }] },
    'google_resolve_invalid',
  ],
  [{ entities: [{ place: 'places/../../admin' }] }, 'google_resolve_invalid'],
  [{ entities: [{ place: 'places/0x123:0x456' }] }, 'google_resolve_invalid'],
  [{ entities: [{ coordinates: [1, 2] }] }, 'google_resolve_invalid'],
  [{}, 'google_resolve_invalid'],
] as const)(
  'refuses malformed, ambiguous or per-item failure %j',
  async (body, code) => {
    await expect(
      resolveGoogleMaps(
        input,
        'parent',
        limits,
        vi.fn().mockResolvedValue(Response.json(body)),
      ),
    ).rejects.toMatchObject({ code });
  },
);
it('refuses invalid JSON without exposing its content', async () => {
  await expect(
    resolveGoogleMaps(
      input,
      'parent',
      limits,
      vi.fn().mockResolvedValue(new Response('<secret>')),
    ),
  ).rejects.toMatchObject({
    code: 'google_resolve_invalid',
    reasonUk: expect.not.stringContaining('<secret>'),
  });
});
it('reuses a durable resolution receipt without HTTP or another spend row', async () => {
  query.mockResolvedValue({
    rows: [
      {
        id: 'receipt',
        status: 'done',
        result: { placeId, sourceUrl: input.sourceUrl },
      },
    ],
  });
  const fetcher = vi.fn();
  expect(await resolveGoogleMaps(input, 'parent', limits, fetcher)).toEqual({
    placeId,
    receiptId: 'receipt',
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    query.mock.calls.some(([sql]) =>
      sql.startsWith('insert into spend_events'),
    ),
  ).toBe(false);
});
it('bounds streamed bytes even without Content-Length', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  await expect(readGoogleBody(new Response(stream), 10)).rejects.toMatchObject({
    code: 'google_response_size',
  });
});
it('rejects an oversized declared body before reading it', async () => {
  await expect(
    readGoogleBody(
      new Response('small', { headers: { 'content-length': '100' } }),
      10,
    ),
  ).rejects.toMatchObject({ code: 'google_response_size' });
});
it('uses the configured timeout and records the failed free attempt', async () => {
  const fetcher = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => reject(Error('synthetic timeout')),
          { once: true },
        ),
      ),
  );
  await expect(
    resolveGoogleMaps(input, 'parent', { ...limits, timeoutMs: 10 }, fetcher),
  ).rejects.toMatchObject({ code: 'google_resolve_network' });
  expect(
    query.mock.calls.some(([sql]) =>
      sql.startsWith('insert into spend_events'),
    ),
  ).toBe(true);
});
