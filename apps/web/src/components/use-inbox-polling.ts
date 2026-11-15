'use client';
import { useEffect, useRef, useState } from 'react';
import { pollInbox } from '@/lib/inbox-polling';
export function useInboxPolling(
  key: string | false,
  refresh: (signal: AbortSignal) => Promise<void>,
) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const [error, setError] = useState(false);
  useEffect(() => {
    if (key === false) return;
    setError(false);
    return pollInbox(async (signal) => {
      try {
        await latest.current(signal);
        if (!signal.aborted) setError(false);
      } catch {
        if (!signal.aborted) setError(true);
      }
    }, document);
  }, [key]);
  return { error };
}
