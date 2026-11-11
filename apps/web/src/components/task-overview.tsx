'use client';
import { useEffect, useState } from 'react';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
type Task = {
  id: string;
  type: string;
  status: string;
  reason_uk: string | null;
  result: {
    approximate?: boolean;
    counts?: Record<string, string | null>;
  } | null;
};
type Count = { type: string; status: string; count: number };
export function useTasks() {
  const [data, setData] = useState<{ tasks: Task[]; counts: Count[] }>({
    tasks: [],
    counts: [],
  });
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const r = await fetch('/api/tasks', { signal: controller.signal });
        if (!r.ok) throw Error();
        setData(await r.json());
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return { ...data, error };
}
export function FailureBadge() {
  const { counts } = useTasks();
  const count = counts
    .filter((x) => x.status === 'failed')
    .reduce((sum, x) => sum + x.count, 0);
  return count ? (
    <span
      className="ml-auto rounded-full bg-err-bg px-2 text-err"
      aria-label={`${uk.tasks.failures}: ${count}`}
    >
      {count}
    </span>
  ) : null;
}
export function TaskOverview() {
  const { tasks, counts, error } = useTasks();
  const [retryError, setRetryError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const name = (type: string) =>
    type === 'system.registry_ping' ? uk.tasks.registry : type;
  const active = [
    ...new Set(
      counts
        .filter((x) => ['queued', 'running'].includes(x.status))
        .map((x) => x.type),
    ),
  ];
  const retry = async (id: string) => {
    setPending(id);
    try {
      const r = await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
      if (!r.ok) throw Error();
      setRetryError(false);
    } catch {
      setRetryError(true);
    } finally {
      setPending(null);
    }
  };
  return (
    <>
      <PageHeader {...uk.pages.overview} />
      {(error || retryError) && (
        <p role="alert" className="mb-4 text-err">
          {uk.tasks.error}
        </p>
      )}
      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-heading text-xl font-bold">
          {uk.tasks.active}
        </h2>
        {active.length === 0 && (
          <p className="text-muted-foreground">{uk.tasks.empty}</p>
        )}
        {active.map((type) => {
          const rows = counts.filter((x) => x.type === type);
          const total = rows.reduce((s, x) => s + x.count, 0);
          const done = rows
            .filter((x) => x.status === 'done')
            .reduce((s, x) => s + x.count, 0);
          return (
            <div key={type} className="mb-4">
              <p>{name(type)}</p>
              <p className="text-sm text-muted-foreground">
                {rows
                  .map(
                    (x) =>
                      `${uk.tasks.status[x.status as keyof typeof uk.tasks.status]}: ${x.count}`,
                  )
                  .join(' · ')}
              </p>
              <progress
                className="w-full"
                aria-label={name(type)}
                value={done}
                max={total}
              />
            </div>
          );
        })}
        <ul className="mt-4 space-y-2 border-t border-border pt-4">
          {tasks.slice(0, 5).map((task) => (
            <li
              key={task.id}
              className="flex flex-wrap justify-between gap-2 text-sm"
            >
              <span>
                {name(task.type)}
                {task.type === 'system.registry_ping' &&
                  task.result?.approximate && (
                    <span className="block text-muted-foreground">
                      {uk.tasks.approximate}:{' '}
                      {Object.entries(task.result.counts ?? {})
                        .map(
                          ([table, count]) =>
                            `${uk.tasks.registryTables[table as keyof typeof uk.tasks.registryTables] ?? table}: ${count ?? uk.tasks.estimateUnavailable}`,
                        )
                        .join(' / ')}
                    </span>
                  )}
              </span>
              <span>
                {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-6">
        <h2 className="mb-4 font-heading text-xl font-bold">
          {uk.tasks.failures}
        </h2>
        {tasks
          .filter((x) => ['failed', 'paused'].includes(x.status))
          .map((task) => (
            <div
              key={task.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4"
            >
              <div className="min-w-0 break-words">
                <p>{name(task.type)}</p>
                <p className="text-sm text-err">{task.reason_uk}</p>
              </div>
              <Button
                disabled={pending === task.id}
                onClick={() => void retry(task.id)}
              >
                {uk.tasks.retry}
              </Button>
            </div>
          ))}
        {!tasks.some((x) => ['failed', 'paused'].includes(x.status)) && (
          <p className="text-muted-foreground">{uk.tasks.noFailures}</p>
        )}
      </Card>
    </>
  );
}
