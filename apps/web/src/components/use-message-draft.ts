'use client';
import { useEffect, useRef, useState } from 'react';
import {
  reconcileDraft,
  draftConflict,
  sameDraft,
  type DraftText,
  type DraftState,
} from '@/lib/draft-state';
const snapshot = ({ subject, body }: DraftText): DraftText => ({
  subject,
  body,
});
export function useMessageDraft(server: DraftText & { id: string }) {
  const [stored, setStored] = useState<DraftState>(() => ({
    id: server.id,
    base: snapshot(server),
    value: snapshot(server),
  }));
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(server);
  latest.current = server;
  const state = reconcileDraft(stored, server);
  if (state !== stored) setStored(state);
  const key = `sonar:message-draft:${server.id}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      const valid = (v: DraftText) =>
        typeof v?.subject === 'string' && typeof v?.body === 'string';
      if (
        saved?.id === latest.current.id &&
        valid(saved.base) &&
        valid(saved.value)
      )
        setStored(
          reconcileDraft(
            {
              id: saved.id,
              base: snapshot(saved.base),
              value: snapshot(saved.value),
            },
            latest.current,
          ),
        );
    } catch {
      /* Retain the in-memory draft when storage is unavailable. */
    }
    setLoaded(true);
  }, [key]);
  useEffect(() => {
    if (!loaded) return;
    try {
      if (sameDraft(state.base, state.value)) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* Retain the in-memory draft. */
    }
  }, [state, key, loaded]);
  return {
    state,
    conflict: draftConflict(state, server),
    setValue: (value: DraftText) =>
      setStored((current) => ({
        ...reconcileDraft(current, latest.current),
        value,
      })),
    useServer: () =>
      setStored({
        id: server.id,
        base: snapshot(server),
        value: snapshot(server),
      }),
    keepLocal: () =>
      setStored((current) => ({ ...current, base: snapshot(latest.current) })),
  };
}
