import { expect, it } from 'vitest';
import { inboxReadSnapshot } from './inbox-read';
const eligible = {
  active: true,
  followingLatest: true,
  newMessages: 0,
  conversationId: 'dialog-a',
  selectedId: 'dialog-a',
};
it('reads backfilled unread A before already-read B and owns an immutable snapshot boundary', () => {
  const incoming = [
    { id: 'a', unread: true },
    { id: 'b', unread: false },
  ];
  const boundary = inboxReadSnapshot(incoming, eligible)!;
  expect(boundary).toEqual({
    action: 'read',
    messageId: 'b',
    visibleMessageIds: ['a', 'b'],
  });
  incoming.unshift({ id: 'older-unseen', unread: true });
  incoming.push({ id: 'future-unseen', unread: true });
  expect(boundary.visibleMessageIds).toEqual(['a', 'b']);
  expect(inboxReadSnapshot(incoming, eligible)?.visibleMessageIds).toEqual([
    'older-unseen',
    'a',
    'b',
    'future-unseen',
  ]);
});
it.each([
  { active: false },
  { followingLatest: false },
  { newMessages: 1 },
  { selectedId: 'dialog-b' },
  { conversationId: undefined },
])('does not acknowledge a snapshot outside its UI gates: %j', (blocked) => {
  expect(
    inboxReadSnapshot([{ id: 'a', unread: true }], { ...eligible, ...blocked }),
  ).toBeNull();
});
it('does not read an empty or fully acknowledged snapshot and re-evaluates unread state', () => {
  expect(inboxReadSnapshot([], eligible)).toBeNull();
  expect(inboxReadSnapshot([{ id: 'b', unread: false }], eligible)).toBeNull();
  expect(
    inboxReadSnapshot([{ id: 'b', unread: true }], eligible)?.messageId,
  ).toBe('b');
});
