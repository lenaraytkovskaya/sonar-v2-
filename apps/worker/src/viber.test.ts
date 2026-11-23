import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  recordInbound: vi.fn(),
  reconcile: vi.fn(),
  enqueueTask: vi.fn(),
  runTask: vi.fn(),
}));

vi.mock('@sonar/db', () => ({ sonarPool: { query: mocks.query } }));
vi.mock('@sonar/db/email', () => ({ sendEmailMessage: vi.fn() }));
vi.mock('@sonar/db/inbound', () => ({ recordInbound: mocks.recordInbound }));
vi.mock('@sonar/db/viber', () => ({
  reconcileViberDeliveries: mocks.reconcile,
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  enqueueTask: mocks.enqueueTask,
  runTask: mocks.runTask,
  TaskFailure: class TaskFailure extends Error {
    constructor(
      public code: string,
      public reasonUk: string,
    ) {
      super(code);
      this.name = 'TaskFailure';
    }
  },
}));

import { pollViberInbound, viberBridgeTimeoutMs } from './viber.js';

const recipient = '+380638215990';

function mockInboxQueries() {
  mocks.query
    .mockResolvedValueOnce({ rows: [{ id: 'account' }] })
    .mockResolvedValueOnce({ rows: [{ to_value: recipient }] })
    .mockResolvedValueOnce({
      rows: [{ to_value: recipient, after: new Date('2026-11-19T09:00:00Z') }],
    })
    .mockResolvedValueOnce({ rows: [{ to_value: '+48500100999' }] });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.query.mockReset();
  mocks.recordInbound.mockReset();
  mocks.reconcile.mockReset();
});

it('uses long bridge request timeouts for inbound and outgoing scans', async () => {
  vi.stubEnv('VIBER_BRIDGE_URL', 'http://viber.test');
  vi.stubEnv('VIBER_BRIDGE_KEY', 'test-key');
  mockInboxQueries();
  mocks.reconcile.mockResolvedValue(0);
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([]));
  vi.stubGlobal('fetch', fetchMock);
  const timeout = vi.spyOn(AbortSignal, 'timeout');

  await pollViberInbound(new Date('2026-11-19T12:00:00Z'));

  expect(timeout).toHaveBeenNthCalledWith(1, 240_000);
  expect(timeout).toHaveBeenNthCalledWith(2, 240_000);
  expect(new URL(fetchMock.mock.calls[0]![0] as URL).pathname).toBe('/inbound');
  expect(new URL(fetchMock.mock.calls[1]![0] as URL).pathname).toBe(
    '/outgoing',
  );
  const outgoingUrl = new URL(fetchMock.mock.calls[1]![0] as URL);
  expect(outgoingUrl.searchParams.get('since')).toBe(
    '2026-11-19T11:30:00.000Z',
  );
  expect(outgoingUrl.searchParams.getAll('to')).toEqual([
    '+48500100999',
    recipient,
  ]);
  expect(mocks.query.mock.calls[3]![1]).toEqual([
    'account',
    new Date('2026-11-19T12:00:00Z'),
  ]);
  expect(mocks.reconcile).toHaveBeenCalledWith(
    [],
    new Date('2026-11-19T12:00:00Z'),
    'account',
  );
  expect(viberBridgeTimeoutMs('/status')).toBe(30_000);
  expect(viberBridgeTimeoutMs('/send')).toBe(240_000);
});

it.each(['AbortError', 'TimeoutError'] as const)(
  'preserves an inbound %s while still reconciling outgoing delivery',
  async (name) => {
    vi.stubEnv('VIBER_BRIDGE_URL', 'http://viber.test');
    vi.stubEnv('VIBER_BRIDGE_KEY', 'test-key');
    mockInboxQueries();
    const outgoing = [
      {
        from: recipient,
        text: 'Full outgoing body',
        at: '2026-11-19T11:55:00Z',
        providerMessageId: 'observed-delivery',
      },
    ];
    mocks.reconcile.mockResolvedValue(1);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        Object.assign(new Error('request timed out'), { name }),
      )
      .mockResolvedValueOnce(Response.json(outgoing));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pollViberInbound(new Date('2026-11-19T12:00:00Z')),
    ).rejects.toMatchObject({
      name: 'TaskFailure',
      code: 'viber_bridge_timeout',
      reasonUk:
        'Міст Viber не відповів за 240 с. Перевірте з’єднання з Viber Desktop і повторіть завдання.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1]![0] as URL).pathname).toBe(
      '/outgoing',
    );
    expect(mocks.reconcile).toHaveBeenCalledWith(
      outgoing,
      new Date('2026-11-19T12:00:00Z'),
      'account',
    );
    expect(mocks.recordInbound).not.toHaveBeenCalled();
  },
);
