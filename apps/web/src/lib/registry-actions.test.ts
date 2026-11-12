import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query, release, enqueue, activity } = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  enqueue: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('@sonar/db', () => ({
  sonarPool: { connect: async () => ({ query, release }) },
}));
vi.mock('@sonar/db/tasks', () => ({
  enqueueTask: enqueue,
  logActivity: activity,
}));
import { registryAction, validRegistryCandidate } from './registry-actions';
const candidate = { type: 'UO' as const, id: '42' };
const decision = {
  companyId: 'company-id',
  candidate,
  action: 'confirm' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue('task-id');
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('select id from companies'))
      return { rowCount: 1, rows: [{ id: 'company-id' }] };
    if (sql.startsWith('select id,value from company_facts'))
      return {
        rows: [
          {
            id: 'fact-id',
            value: [
              { entity_type: 'UO', id: '42' },
              { entity_type: 'FOP', id: '43' },
            ],
          },
        ],
      };
    return { rows: [], rowCount: 0 };
  });
});
describe('registry actions', () => {
  it('validates registry table identity rather than accepting arbitrary IDs', () => {
    expect(validRegistryCandidate(candidate)).toBe(true);
    for (const value of [
      null,
      { type: 'other', id: '42' },
      { type: 'UO', id: '1 or true' },
      { type: 'UO', id: 42 },
    ])
      expect(validRegistryCandidate(value)).toBe(false);
  });
  it('rejects a stale or forged candidate without queuing work', async () => {
    expect(
      await registryAction('actor', {
        ...decision,
        candidate: { type: 'UO', id: '99' },
      }),
    ).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith('commit');
    expect(release).toHaveBeenCalledOnce();
  });
  it('queues a validated confirmation with the authenticated actor', async () => {
    await registryAction('actor', decision);
    expect(enqueue).toHaveBeenCalledWith(
      'registry.match',
      expect.stringMatching(/^registry.confirm:company-id:/),
      { companyId: 'company-id', candidate, actorId: 'actor' },
      expect.anything(),
    );
    expect(
      query.mock.calls.findIndex(([sql]) => sql.includes('for update')),
    ).toBeLessThan(
      query.mock.calls.findIndex(([sql]) => sql.startsWith('select id,value')),
    );
  });
  it('deduplicates confirmations only for the same candidate', async () => {
    query.mockImplementation(async (sql: string, values?: string[]) => {
      if (sql.startsWith('select id from companies'))
        return { rowCount: 1, rows: [{ id: 'company-id' }] };
      if (sql.startsWith('select id,value from company_facts'))
        return {
          rows: [{ id: 'fact-id', value: [{ entity_type: 'UO', id: '42' }] }],
        };
      if (sql.startsWith('select id,status from tasks')) {
        expect(sql).toContain("payload->'candidate'->>'id'=$3");
        expect(values).toEqual(['company-id', 'UO', '42']);
        return { rows: [{ id: 'existing', status: 'queued' }] };
      }
      return { rows: [] };
    });
    expect(await registryAction('actor', decision)).toEqual({
      id: 'existing',
      status: 'queued',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('removes only the rejected candidate and preserves the rejected identity and actor', async () => {
    await registryAction('actor', { ...decision, action: 'reject' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      'update company_facts set value=$2 where id=$1',
      ['fact-id', JSON.stringify([{ entity_type: 'FOP', id: '43' }])],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'registry_rejected'"),
      ['company-id', JSON.stringify(candidate)],
    );
    expect(activity).toHaveBeenCalledWith(
      'registry.candidate.rejected',
      'company',
      'company-id',
      'actor',
      { candidate },
      expect.anything(),
    );
  });
  it('serializes global sync requests and reuses an active task', async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("type='registry.phones.sync'")
        ? [{ id: 'existing', status: 'running' }]
        : [],
    }));
    expect(await registryAction('actor')).toEqual({
      id: 'existing',
      status: 'running',
    });
    expect(query).toHaveBeenCalledWith(
      "select pg_advisory_xact_lock(hashtext('registry.phones.sync'))",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rolls back if queuing fails', async () => {
    enqueue.mockRejectedValueOnce(Error('queue unavailable'));
    await expect(registryAction('actor')).rejects.toThrow('queue unavailable');
    expect(query).toHaveBeenCalledWith('rollback');
    expect(release).toHaveBeenCalledOnce();
  });
});
