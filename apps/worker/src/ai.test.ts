import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const { query, budgeted } = vi.hoisted(() => ({
  query: vi.fn(),
  budgeted: vi.fn(async (_service, _estimate, _id, run) => run()),
}));
vi.mock('@sonar/db', () => ({ sonarPool: { query } }));
vi.mock('@sonar/db/budget', async (original) => ({
  ...(await original<object>()),
  runBudgetedRequest: budgeted,
}));
vi.mock('@sonar/db/tasks', () => ({
  boss: {},
  runTask: vi.fn(),
  TaskFailure: class extends Error {},
}));
import { runAiAssist } from './ai.js';
const suggestion = {
  name: 'Авто',
  country_code: 'UA',
  language_code: 'uk',
  cities: ['Київ'],
  queries: ['СТО', 'автосервіс', 'ремонт авто', 'діагностика', 'шиномонтаж'],
  offer: 'Доброго дня! Пропонуємо обладнання.',
  needs_about: false,
};
const migration = readFileSync(
  new URL(
    '../../../packages/db/drizzle/0009_campaign_suggestions.sql',
    import.meta.url,
  ),
  'utf8',
);
const instruction = migration.split('$prompt$')[1];
beforeEach(() => vi.clearAllMocks());
it.each(['Обладнання для СТО.', '', '   ', undefined])(
  'passes authoritative company.about separately from recipient context (%s)',
  async (about) => {
    query.mockResolvedValue({
      rows: Object.entries({
        'ai.actions': { campaign: instruction },
        'company.about': about,
        'ai.models': [
          { id: 'stub', promptUsd: 0, completionUsd: 0, requestUsd: 0 },
        ],
        'ai.model.cheap': 'stub',
        'ai.max_tokens': { campaign: 2000 },
      }).map(([key, value]) => ({ key, value })),
    });
    const complete = vi.fn(async () => ({
      text: JSON.stringify(suggestion),
      costUsd: 0.001,
      units: 10,
      id: 'stub',
      model: 'stub',
    }));
    const result = await runAiAssist(
      {
        action: 'campaign',
        text: 'автосервіси та СТО Києва й Київської області',
        context: 'recipient context',
      },
      'task',
      { complete, models: vi.fn() },
    );
    const message = complete.mock.calls[0] as unknown as [
      string,
      { content: string }[],
      number,
    ];
    expect(message[1][1]!.content).toContain(
      `"company.about":"${about?.trim() ?? ''}"`,
    );
    expect(message[1][1]!.content).toContain('"context":"recipient context"');
    expect(message[1][1]!.content).toContain(instruction);
    expect(result).toMatchObject({
      status: 'done',
      result: {
        suggestion: {
          offer: about?.trim() ? suggestion.offer : '',
          needs_about: !about?.trim(),
        },
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(budgeted).toHaveBeenCalledTimes(1);
  },
);
it('migration specifies geography, business-only queries and factual first-message contract', () => {
  for (const rule of [
    '5-10',
    'business categories and synonyms ONLY',
    'NEVER include geography',
    'center plus 8-15',
    '15-25',
    'FIRST outreach message',
    'company.about',
    'needs_about=true',
    'never repeat it as the offer',
    'invent sender',
  ])
    expect(instruction).toContain(rule);
  expect(migration).toContain("jsonb_set(value, '{campaign}'");
  expect(migration).toContain("WHERE key='ai.actions'");
});
