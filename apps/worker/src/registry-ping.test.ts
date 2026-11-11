import { expect, it, vi } from 'vitest';
import { readRegistryEstimates } from './registry-ping.js';

it('reads only catalog estimates and preserves unknown estimates', async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      { table: 'edr_legal_entities', count: '15000000' },
      { table: 'edr_fops', count: null },
    ],
  });
  expect(await readRegistryEstimates({ query })).toEqual({
    approximate: true,
    counts: { edr_legal_entities: '15000000', edr_fops: null },
  });
  expect(query).toHaveBeenCalledOnce();
  const [sql, values] = query.mock.calls[0]!;
  expect(sql).toContain('from pg_class');
  expect(sql).toContain('reltuples');
  expect(sql).not.toMatch(/count\s*\(\s*\*\s*\)|from\s+(?:public\.)?edr_/i);
  expect(values[0]).toHaveLength(5);
});

it('propagates unavailable registry or missing table errors', async () => {
  const query = vi.fn().mockRejectedValue(new Error('relation does not exist'));
  await expect(readRegistryEstimates({ query })).rejects.toThrow(
    'relation does not exist',
  );
});
