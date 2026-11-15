export type DraftText = { subject: string; body: string };
export type DraftState = { id: string; base: DraftText; value: DraftText };
export const sameDraft = (a: DraftText, b: DraftText) =>
  a.subject === b.subject && a.body === b.body;
export const normalizedDraft = (text: DraftText): DraftText => ({
  subject: text.subject.trim(),
  body: text.body.trim(),
});
export function reconcileDraft(
  state: DraftState,
  server: DraftText & { id: string },
): DraftState {
  if (
    state.id !== server.id ||
    (!sameDraft(state.base, server) &&
      (sameDraft(state.value, state.base) ||
        sameDraft(normalizedDraft(state.value), server)))
  )
    return {
      id: server.id,
      base: { subject: server.subject, body: server.body },
      value: { subject: server.subject, body: server.body },
    };
  return state;
}
export const draftConflict = (state: DraftState, server: DraftText) =>
  !sameDraft(state.base, server) && !sameDraft(state.value, server);
/** Optional for older clients; malformed guards must never silently disable CAS. */
export function expectedDraft(value: unknown): DraftText | undefined | false {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return false;
  const text = value as DraftText;
  return typeof text.subject === 'string' &&
    text.subject.length <= 998 &&
    typeof text.body === 'string' &&
    text.body.length <= 100000
    ? { subject: text.subject, body: text.body }
    : false;
}
