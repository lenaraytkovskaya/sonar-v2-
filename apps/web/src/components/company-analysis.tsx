'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnalysisResult } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { Button } from './ui/button';
type Task = {
  id: string;
  status: string;
  reason_uk?: string | null;
  analysis_id?: string | null;
};
export function CompanyAnalysis({
  companyId,
  campaignId,
  analysis,
}: {
  companyId: string;
  campaignId: string;
  analysis?: {
    id: string;
    result: AnalysisResult;
    model: string;
    cost_usd: string;
    created_at: string | Date;
  };
}) {
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const active = !!task && ['queued', 'running'].includes(task.status);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(
          `/api/companies/${companyId}/analyze?campaignId=${campaignId}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw Error(uk.ai.error);
        const next = (await response.json()) as Task | null;
        setTask(next);
        if (
          (active && next && !['queued', 'running'].includes(next.status)) ||
          (next?.status === 'done' &&
            next.analysis_id &&
            next.analysis_id !== analysis?.id)
        )
          router.refresh();
      } catch {
        if (!controller.signal.aborted) setMessage(uk.ai.error);
      }
    };
    void load();
    const timer = active ? setInterval(() => void load(), 3000) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [companyId, campaignId, active, analysis?.id, router]);
  const run = async () => {
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/api/companies/${companyId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId }),
      });
      if (!response.ok) throw Error(uk.ai.error);
      setTask(await response.json());
      router.refresh();
    } catch {
      setMessage(uk.ai.error);
    } finally {
      setPending(false);
    }
  };
  const result = analysis?.result;
  return (
    <div className="space-y-3">
      <Button disabled={pending || active} onClick={() => void run()}>
        {pending || active ? uk.ai.pending : uk.analysis.run}
      </Button>
      {task && (
        <p className="text-sm text-muted-foreground">
          <StatusBadge status={task.status}>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
          </StatusBadge>
          {task.reason_uk && ` · ${task.reason_uk}`}
        </p>
      )}
      {result ? (
        <>
          <p className="whitespace-pre-wrap">{result.summary}</p>
          <p>
            {uk.analysis.language}: {result.language}
          </p>
          <p>
            {uk.analysis.channel}:{' '}
            {result.best_channel
              ? uk.company.kinds[result.best_channel]
              : uk.company.noData}
          </p>
          <p>
            {uk.analysis.fit}: <strong>{result.fit}/100</strong> ·{' '}
            {result.fit_reason}
          </p>
          <h4 className="font-semibold">{uk.analysis.draft}</h4>
          {result.first_message ? (
            <>
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-raised p-3">
                {result.first_message}
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(result.first_message)
                    .then(() => setMessage(uk.analysis.copied))
                    .catch(() => setMessage(uk.ai.error))
                }
              >
                {uk.analysis.copy}
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">{uk.analysis.noDraft}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {uk.analysis.model}: {analysis.model} · {uk.analysis.cost}: $
            {Number(analysis.cost_usd).toFixed(6)} ·{' '}
            {new Date(analysis.created_at).toLocaleString('uk-UA')}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">{uk.analysis.empty}</p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
