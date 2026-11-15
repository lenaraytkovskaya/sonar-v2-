import { expect, it } from 'vitest';
import {
  reconcileDraft,
  draftConflict,
  expectedDraft,
  type DraftState,
} from './draft-state';
const old = { id: 'first', subject: 'Old subject', body: 'Old text' };
const next = { ...old, subject: 'New subject', body: 'New text' };
const initial: DraftState = { id: old.id, base: old, value: old };
it('adopts both server fields before any local edit (a pristine update must never save old text)', () => {
  const state = reconcileDraft(initial, next);
  expect(state.value).toEqual({ subject: next.subject, body: next.body });
  expect(state.base).toEqual({ subject: next.subject, body: next.body });
  expect(draftConflict(state, next)).toBe(false);
});
it('retains edits across polls/remounts and requires an explicit conflict choice', () => {
  const local = {
    ...initial,
    value: { subject: 'My subject', body: 'My text' },
  };
  expect(reconcileDraft(local, old)).toBe(local);
  const restored = JSON.parse(JSON.stringify(local));
  const conflict = reconcileDraft(restored, next);
  expect(conflict.value).toEqual(local.value);
  expect(draftConflict(conflict, next)).toBe(true);
  const keepLocal = { ...conflict, base: next };
  expect(draftConflict(keepLocal, next)).toBe(false);
  expect(keepLocal.value).toEqual(local.value);
});
it('acknowledges saved/trimmed text; resetting identity cannot leak another thread’s draft', () => {
  const dirty = {
    ...initial,
    value: { subject: ' New subject ', body: ' New text ' },
  };
  expect(reconcileDraft(dirty, next).value).toEqual({
    subject: next.subject,
    body: next.body,
  });
  const switched = reconcileDraft(dirty, { ...next, id: 'second' });
  expect(switched.id).toBe('second');
  expect(switched.value).toEqual({ subject: next.subject, body: next.body });
});
it('rejects malformed concurrency guards rather than silently disabling them', () => {
  for (const invalid of [
    null,
    false,
    {},
    { subject: '', body: 5 },
    { subject: '', body: 'x'.repeat(100001) },
  ])
    expect(expectedDraft(invalid)).toBe(false);
  expect(expectedDraft(undefined)).toBeUndefined();
  expect(expectedDraft(next)).toEqual({
    subject: next.subject,
    body: next.body,
  });
});
