import { expect, it } from 'vitest';
import {
  campaignProgressPollSchema,
  orderedTaskTypes,
} from './task-progress.js';
it('orders task stages, retains unknown work, and never mutates counts', () => {
  const types = [
    'message.send',
    'company.analyze',
    'site.scan',
    'ai.drafts',
    'company.score',
    'google.request',
    'registry.match',
    'prozorro.company',
    'other',
  ];
  const counts = types.map((type) => ({ type, status: 'done', count: 1 }));
  const snapshot = structuredClone(counts);
  expect(orderedTaskTypes([...counts, ...counts])).toEqual([
    'google.request',
    'prozorro.company',
    'registry.match',
    'site.scan',
    'company.score',
    'company.analyze',
    'ai.drafts',
    'message.send',
    'other',
  ]);
  expect(counts).toEqual(snapshot);
});
it('shows only positive queued or running types for the global active view', () => {
  expect(
    orderedTaskTypes(
      [
        { type: 'google.request', status: 'done', count: 10 },
        { type: 'site.scan', status: 'queued', count: 1 },
        { type: 'company.score', status: 'running', count: 2 },
        { type: 'company.analyze', status: 'paused', count: 1 },
        { type: 'ai.drafts', status: 'queued', count: 0 },
      ],
      true,
    ),
  ).toEqual(['site.scan', 'company.score']);
  expect(orderedTaskTypes([])).toEqual([]);
});
it.each([5000, 7500, 10000])('accepts DB polling interval %s', (value) => {
  expect(campaignProgressPollSchema.parse(value)).toBe(value);
});
it.each([4999, 10001, 7500.5, '7500', null])(
  'rejects invalid polling interval %s',
  (value) => {
    expect(campaignProgressPollSchema.safeParse(value).success).toBe(false);
  },
);
