import { beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignPauseScopes } from '@sonar/core';

const query = vi.fn();
const dispatch = vi.fn(async () => {});
vi.mock('./index.js', () => ({ sonarPool: { query } }));
vi.mock('./tasks.js', () => ({
  dispatch,
  logActivity: vi.fn(async () => {}),
  transaction: (fn: (client: { query: typeof query }) => unknown) =>
    fn({ query }),
}));
const { taskBlockedByPause, pauseCampaign, resumeCampaign } =
  await import('./campaign-run.js');

const campaign = '11111111-1111-4111-8111-111111111111';
const payloads: Record<string, Record<string, string>> = {
  campaign: { campaignId: campaign },
  message: { messageId: 'm1' },
  batch: { batchId: 'b1' },
  company: { companyId: 'c1' },
};
// Answers the lookup of a task's campaigns and the status of those campaigns.
const campaignsAre = (...statuses: string[]) => {
  query.mockReset();
  query.mockImplementation(async (sql: string) =>
    sql.startsWith('select status')
      ? { rows: statuses.map((status) => ({ status })) }
      : { rows: statuses.map(() => ({ id: campaign })) },
  );
};

beforeEach(() => {
  query.mockReset();
  dispatch.mockClear();
});

describe('pause holds every campaign task type', () => {
  const guarded = Object.entries(campaignPauseScopes).filter(
    ([, rule]) => rule.guard,
  );
  it.each(guarded)(
    '%s is held while the campaign is paused',
    async (type, rule) => {
      campaignsAre('paused');
      const payload = payloads[rule.scope]!;
      expect(
        await taskBlockedByPause({ query } as never, { type, payload }),
      ).toBe(true);
    },
  );
  it.each(guarded)(
    '%s runs while the campaign is active',
    async (type, rule) => {
      campaignsAre('active');
      expect(
        await taskBlockedByPause({ query } as never, {
          type,
          payload: payloads[rule.scope]!,
        }),
      ).toBe(false);
    },
  );
  it('lets a company in a running campaign keep working', async () => {
    campaignsAre('paused', 'active');
    expect(
      await taskBlockedByPause({ query } as never, {
        type: 'site.scan',
        payload: payloads.company!,
      }),
    ).toBe(false);
  });
  it('ignores task types that do not belong to a campaign', async () => {
    expect(
      await taskBlockedByPause({ query } as never, {
        type: 'telegram.sync',
        payload: {},
      }),
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it('leaves self-pausing types to their own handlers', async () => {
    for (const type of ['google.batch', 'message.send'])
      expect(
        await taskBlockedByPause({ query } as never, {
          type,
          payload: payloads.message!,
        }),
      ).toBe(false);
  });
});

describe('pause and resume', () => {
  it('pauses only an active campaign', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await pauseCampaign(campaign, 'u')).toEqual({ paused: false });
    expect(query.mock.calls[0]![0]).toContain("status='active'");
  });
  it('resume queues held tasks again without creating a batch', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({
      rows: [
        { id: 't1', type: 'site.scan' },
        { id: 't2', type: 'message.send' },
      ],
    });
    expect(await resumeCampaign(campaign, 'u')).toEqual({
      resumed: true,
      requeued: 2,
    });
    expect(dispatch.mock.calls.map((call) => call[1])).toEqual(['t1', 't2']);
    const sql = String(query.mock.calls[1]![0]);
    expect(sql).toContain("t.status='paused'");
    expect(sql).not.toContain('insert into batches');
  });
  it('a repeated resume queues nothing and sends nothing twice', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await resumeCampaign(campaign, 'u')).toEqual({
      resumed: false,
      requeued: 0,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
