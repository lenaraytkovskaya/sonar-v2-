'use client';
import { useEffect, useRef, useState } from 'react';
import { uk } from '@/i18n/uk';
import { createTaskPolling } from '@/lib/task-polling';
import { Callout, Section } from './ui/layout';
import {
  TaskActivitySection,
  useTasks,
  type Count,
  type Task,
} from './task-overview';
type Progress = {
  tasks: Task[];
  counts: Count[];
  failures: Task[];
  olderFailures: Task[];
};
export function CampaignRunning({
  campaignId,
  pollMs,
  refreshToken,
}: {
  campaignId: string;
  pollMs: number;
  refreshToken: number;
}) {
  const { counts, tasks } = useTasks();
  const fingerprint = JSON.stringify([
    counts
      .map(({ type, status, count }) => `${type}:${status}:${count}`)
      .sort(),
    tasks[0]?.id,
  ]);
  const previous = useRef(fingerprint);
  const token = useRef(refreshToken);
  const polling = useRef<ReturnType<typeof createTaskPolling<Progress>> | null>(
    null,
  );
  const [data, setData] = useState<Progress | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const runner = createTaskPolling<Progress>({
      interval: pollMs,
      load: async (signal) => {
        const response = await fetch(
          `/api/tasks?campaignId=${encodeURIComponent(campaignId)}`,
          { signal },
        );
        if (!response.ok) throw Error();
        return response.json();
      },
      active: (value) =>
        value.counts.some(
          (row) => row.count > 0 && ['queued', 'running'].includes(row.status),
        ),
      onData: (value) => {
        setData(value);
        setError(false);
      },
      onError: () => setError(true),
    });
    polling.current = runner;
    runner.refresh(true);
    const visible = () => {
      if (document.visibilityState === 'visible') runner.refresh(true);
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      runner.stop();
      polling.current = null;
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [campaignId, pollMs]);
  useEffect(() => {
    if (previous.current === fingerprint) return;
    previous.current = fingerprint;
    polling.current?.refresh();
  }, [fingerprint]);
  useEffect(() => {
    if (token.current === refreshToken) return;
    token.current = refreshToken;
    polling.current?.refresh(true);
  }, [refreshToken]);
  return (
    <div className="space-y-3" aria-live="polite">
      {error && (
        <Callout tone="err">{data ? uk.tasks.stale : uk.tasks.error}</Callout>
      )}
      {data ? (
        <TaskActivitySection
          tasks={data.tasks}
          counts={data.counts}
          failures={[...data.failures, ...data.olderFailures]}
          emptyText={uk.tasks.campaignEmpty}
          description={uk.tasks.progressHint}
        />
      ) : (
        <Section title={uk.tasks.active}>
          <p className="text-sm text-muted-foreground">{uk.tasks.loading}</p>
        </Section>
      )}
    </div>
  );
}
