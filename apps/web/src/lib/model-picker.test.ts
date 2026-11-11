import { describe, expect, it } from 'vitest';
import type { TextModel } from '@sonar/core';
import { filterModels } from './model-picker';

const model = (
  id: string,
  output: number,
  name = id,
  input = 0,
  request = 0,
): TextModel => ({
  id,
  name,
  promptUsd: input / 1e6,
  completionUsd: output / 1e6,
  requestUsd: request,
});
const ids = (models: TextModel[], query = '', cheap = false, selected = '') =>
  filterModels(models, query, cheap, selected).map((m) => m.id);

describe('model picker', () => {
  const haiku = model('anthropic/claude-haiku-5.5', 2, 'Claude Haiku 5.5');
  it('finds case-insensitive substrings in both the ID and display name', () => {
    expect(ids([haiku], ' HAIKU ')).toEqual([haiku.id]);
    expect(ids([model('vendor/123', 1, 'Friendly Model')], 'FRIENDLY')).toEqual(
      ['vendor/123'],
    );
    expect(ids([haiku], 'ANTHROPIC/CLAUDE')).toEqual([haiku.id]);
    expect(ids([haiku], 'missing')).toEqual([]);
  });
  it('includes free and exactly $1 output, excludes output above $1 regardless of input', () => {
    expect(
      ids(
        [
          model('free', 0),
          model('boundary', 1, 'Boundary', 20),
          model('above', 1.000001),
        ],
        '',
        true,
      ),
    ).toEqual(['free', 'boundary']);
  });
  it('ranks ID prefixes before cheaper substring and name matches', () => {
    expect(
      ids(
        [
          model('other/haiku', 0),
          model('name-match', 0, 'Haiku'),
          model('HAIKU/provider', 9),
        ],
        'haiku',
      ),
    ).toEqual(['HAIKU/provider', 'name-match', 'other/haiku']);
  });
  it('uses prompt + completion, then request price, then deterministic ID ties', () => {
    const models = [
      model('b', 1, 'B', 1),
      model('a', 2),
      model('fee', 1, 'Fee', 1, 0.01),
      model('lowest', 1.5),
    ];
    expect(ids(models)).toEqual(['lowest', 'a', 'b', 'fee']);
    expect(ids([...models].reverse())).toEqual(ids(models));
    expect(models[0]?.id).toBe('b');
  });
  it('keeps a selected model excluded by search and price, without duplicating or pinning it', () => {
    expect(ids([haiku, model('free', 0)], 'free', true, haiku.id)).toEqual([
      'free',
      haiku.id,
    ]);
    expect(ids([haiku], 'haiku', false, haiku.id)).toEqual([haiku.id]);
    expect(ids([], '', true, 'stale/id')).toEqual([]);
  });
});
