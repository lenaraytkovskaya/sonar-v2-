'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { getFormReplyMatch } from '@sonar/db/form-replies';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { useInboxPolling } from './use-inbox-polling';
import { FriendlyError } from './friendly-error';

type Match = Awaited<ReturnType<typeof getFormReplyMatch>>;
export function FormReplyMatch({
  conversationId,
  active,
  companyId,
}: {
  conversationId: string;
  active: boolean;
  companyId: string | null;
}) {
  const router = useRouter();
  const [match, setMatch] = useState<Match>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const previous = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const path = `/api/conversations/${conversationId}/form-match`;
  useInboxPolling(active && path, async (signal) => {
    if (busy.current) return;
    const response = await fetch(path, { signal, cache: 'no-store' });
    if (!response.ok) throw Error();
    const next: Match = await response.json();
    if (signal.aborted || busy.current) return;
    const binding = next?.state === 'bound' ? (next.companyId ?? '') : '';
    if (
      (previous.current !== undefined && previous.current !== binding) ||
      (previous.current === undefined &&
        next?.state === 'bound' &&
        binding !== (companyId ?? ''))
    )
      router.refresh();
    previous.current = binding;
    setMatch(next);
  });
  const act = async (action: 'bind' | 'unbind' | 'reject') => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, companyId: match?.suggestedCompanyId }),
      });
      const result: Match & { error?: string } = await response.json();
      if (!response.ok) throw Error(result?.error ?? uk.email.error);
      setMatch(result);
      previous.current =
        result?.state === 'bound' ? (result.companyId ?? '') : '';
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  if (!match || !['bound', 'suggested'].includes(match.state)) return null;
  return (
    <section
      aria-label={uk.inbound.binding}
      className="max-h-[35%] shrink-0 space-y-2 overflow-y-auto overscroll-contain border-b border-border p-3 text-sm"
    >
      <p className="text-xs font-medium">
        {match.state === 'bound'
          ? match.method === 'manual'
            ? uk.inbound.manualMatch
            : match.method === 'ai'
              ? uk.inbound.aiMatch
              : uk.inbound.automaticMatch
          : uk.inbound.probableCompany}
      </p>
      {match.state === 'suggested' && (
        <p className="font-medium">
          {match.suggestedCompanyName ?? uk.inbound.unknownCompany}
        </p>
      )}
      {match.reasonUk && (
        <p className="text-xs text-muted-foreground"><FriendlyError reason={match.reasonUk} /></p>
      )}
      {match.confidence != null && (
        <p className="text-xs text-muted-foreground">
          {uk.inbound.confidence}: {Math.round(match.confidence * 100)}%
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {match.state === 'bound' ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void act('unbind')}
          >
            {uk.inbound.unbind}
          </Button>
        ) : (
          <>
            <Button
              disabled={pending || !match.suggestedCompanyId}
              onClick={() => void act('bind')}
            >
              {uk.inbound.bind}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void act('reject')}
            >
              {uk.inbound.rejectMatch}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </section>
  );
}
