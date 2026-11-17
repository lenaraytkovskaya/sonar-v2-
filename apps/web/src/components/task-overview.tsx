'use client';
import Link from 'next/link';
import type { WorkerHealth } from '@sonar/core';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { uk } from '@/i18n/uk';
import { Callout, Section } from '@/components/ui/layout';
import { Button } from '@/components/ui/button';
import { ScanSummary, type ScanResult } from './shared';
type Task = {
  id: string;
  type: string;
  subject_id?: string;
  company_name?: string;
  status: string;
  reason_uk: string | null;
  repetitions: number;
  result:
    | (ScanResult & {
        billingPending?: boolean;
        approximate?: boolean;
        counts?: Record<string, string | null>;
      })
    | null;
};
type Batch = {
  id: string;
  size: number;
  status: string;
  found_new: number;
  found_known: number;
  requests: number;
  cost_usd: string;
  reason_uk: string | null;
  fixture: boolean;
  campaign_name: string;
  companies: number;
  enriching: number;
  enriched: number;
};
type Count = { type: string; status: string; count: number };
function useTaskPolling() {
  const [data, setData] = useState<{
    batches: Batch[];
    tasks: Task[];
    failures: Task[];
    counts: Count[];
    sentToday: number;
    unreadCount: number;
    workerHealth: WorkerHealth | null;
  }>({
    tasks: [],
    batches: [],
    failures: [],
    counts: [],
    sentToday: 0,
    unreadCount: 0,
    workerHealth: null,
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
const TasksContext = createContext<ReturnType<typeof useTaskPolling> | null>(
  null,
);
export function TasksProvider({ children }: { children: ReactNode }) {
  const value = useTaskPolling();
  return (
    <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
  );
}
export function useTasks() {
  const context = useContext(TasksContext);
  if (!context) throw Error('TasksProvider missing');
  return context;
}
export function WorkerStatus() {
  const { workerHealth } = useTasks();
  if (!workerHealth || workerHealth.worker) return null;
  const time = workerHealth.heartbeatAt
    ? new Date(workerHealth.heartbeatAt).toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-err/20 bg-err-bg px-4 py-3 text-sm text-err md:px-6"
    >
      {time
        ? uk.tasks.workerStopped.replace('{time}', time)
        : uk.tasks.workerMissing}
    </div>
  );
}
export function FailureBadge({ inbox = false }: { inbox?: boolean }) {
  const { failures, unreadCount } = useTasks();
  const count = inbox ? unreadCount : failures.length;
  return count ? (
    <span
      className="ml-auto rounded-full bg-err-bg px-2 text-err"
      aria-label={`${inbox ? uk.inbound.unread : uk.tasks.failures}: ${count}`}
    >
      {count}
    </span>
  ) : null;
}
export function TaskOverview() {
  const { tasks, failures, counts, error, batches, sentToday } = useTasks();
  const [retryError, setRetryError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<string | null>(null);
  const name = (type: string) =>
    ({
      'system.registry_ping': uk.tasks.registry,
      'registry.match': uk.company.registry,
      'registry.phones.sync': uk.registry.sync,
      'prozorro.sync': uk.prozorro.title,
      'prozorro.lookup': uk.prozorro.title,
      'prozorro.company': uk.prozorro.title,
      'ai.models': uk.tasks.aiModels,
      'ai.assist': uk.tasks.aiAssist,
      'ai.drafts': uk.outreach.generate,
      'ai.inbound': uk.inbound.classify,
      'ai.reply': uk.inbound.suggest,
      'email.receive': uk.inbound.received,
      'whatsapp.receive': uk.inbound.received,
      'google.batch': uk.google.title,
      'google.request': uk.google.title,
      'google.company': uk.google.title,
      'google.resolve': uk.google.title,
      'site.scan': uk.scanner.title,
      'social.fetch': uk.social.title,
      'social.request': uk.social.title,
      'company.score': uk.company.score,
      'company.analyze': uk.analysis.title,
      'message.send': uk.email.title,
    })[type] ?? type;
  const active = [
    ...new Set(
      counts
        .filter((x) => ['queued', 'running'].includes(x.status))
        .map((x) => x.type),
    ),
  ];
  const retry = async (id: string, action = 'retry', charged?: boolean) => {
    setPending(id);
    try {
      const r = await fetch(`/api/tasks/${id}/${action}`, {
        method: 'POST',
        ...(charged === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ charged }),
            }),
      });
      if (!r.ok) throw Error();
      setRetryError(false);
      setReconciling(null);
    } catch {
      setRetryError(true);
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="space-y-6">
      {(error || retryError) && <Callout tone="err">{uk.tasks.error}</Callout>}
      <Section
        title={uk.tasks.failures}
        description={failures.length ? undefined : uk.tasks.noFailures}
      >
        {failures.length > 0 && (
          <ul className="divide-y divide-border">
            {failures.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1 break-words">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {name(task.type)}
                    <StatusText status={task.status} />
                  </p>
                  <p
                    className={
                      task.status === 'paused'
                        ? 'mt-0.5 text-sm text-wait'
                        : 'mt-0.5 text-sm text-err'
                    }
                  >
                    {task.reason_uk}
                    <span className="text-muted-foreground">
                      {' '}
                      · {uk.tasks.repetitions}: {task.repetitions}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    disabled={pending === task.id}
                    onClick={() => void retry(task.id, 'dismiss')}
                  >
                    {uk.tasks.dismiss}
                  </Button>
                  {task.result?.billingPending ? (
                    reconciling === task.id ? (
                      <>
                        <Button
                          variant="outline"
                          disabled={pending === task.id}
                          onClick={() => void retry(task.id, 'reconcile', true)}
                        >
                          {uk.tasks.charged}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={pending === task.id}
                          onClick={() =>
                            void retry(task.id, 'reconcile', false)
                          }
                        >
                          {uk.tasks.notCharged}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => setReconciling(task.id)}
                      >
                        {uk.tasks.reconcile}
                      </Button>
                    )
                  ) : task.type ===
                    'social.request' ? null : task.type.startsWith(
                      'whatsapp.account.',
                    ) ? (
                    <Button asChild variant="outline">
                      <Link href="/channels">{uk.pages.channels.title}</Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={pending === task.id}
                      onClick={() => void retry(task.id)}
                    >
                      {uk.tasks.retry}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {batches.length > 0 && (
        <Section title={uk.tasks.batches}>
          <ul className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {batches.slice(0, 6).map((batch) => (
              <li
                key={batch.id}
                className="space-y-3 rounded-lg border border-border p-4 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {batch.campaign_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {batch.fixture ? uk.google.fixture : uk.google.estimated}{' '}
                      · ${Number(batch.cost_usd).toFixed(3)}
                    </p>
                  </div>
                  <StatusText status={batch.status} />
                </div>
                <ProgressRow
                  label={uk.google.title}
                  value={batch.found_new + batch.found_known}
                  max={batch.size}
                />
                {batch.companies > 0 && (
                  <ProgressRow
                    label={
                      batch.enriching > 0
                        ? `${uk.enrich.progress} · ${uk.enrich.running}: ${batch.enriching}`
                        : uk.enrich.progress
                    }
                    value={batch.enriched}
                    max={batch.companies}
                  />
                )}
                {batch.reason_uk && (
                  <p className="text-xs text-muted-foreground">
                    {batch.reason_uk}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        title={uk.tasks.active}
        description={`${uk.email.sentToday}: ${sentToday}`}
      >
        {active.length === 0 && (
          <p className="text-sm text-muted-foreground">{uk.tasks.empty}</p>
        )}
        {active.length > 0 && (
          <ul className="grid gap-4 md:grid-cols-2">
            {active.map((type) => {
              const rows = counts.filter((x) => x.type === type);
              const total = rows.reduce((s, x) => s + x.count, 0);
              const done = rows
                .filter((x) => x.status === 'done')
                .reduce((s, x) => s + x.count, 0);
              return (
                <li key={type} className="space-y-1.5 text-sm">
                  <ProgressRow label={name(type)} value={done} max={total} />
                  <p className="text-xs text-muted-foreground">
                    {rows
                      .map(
                        (x) =>
                          `${uk.tasks.status[x.status as keyof typeof uk.tasks.status]}: ${x.count}`,
                      )
                      .join(' · ')}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {tasks
            // Registry health checks repeat every few minutes; one line is enough.
            .filter(
              (task, index, all) =>
                task.type !== 'system.registry_ping' ||
                all.findIndex((other) => other.type === task.type) === index,
            )
            .slice(0, 5)
            .map((task) => (
              <li
                key={task.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-2.5 text-sm break-words"
              >
                <span className="min-w-0">
                  {name(task.type)}
                  {task.company_name && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {task.company_name}
                    </span>
                  )}
                  {task.reason_uk && (
                    <span className="block text-xs text-muted-foreground">
                      {task.reason_uk}
                    </span>
                  )}
                  {task.type === 'site.scan' && (
                    <ScanSummary result={task.result} />
                  )}
                  {task.type === 'system.registry_ping' &&
                    task.result?.approximate && (
                      <span className="block text-xs text-muted-foreground">
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
                <StatusText status={task.status} />
              </li>
            ))}
        </ul>
      </Section>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {value} / {max}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-chip"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${max ? Math.min((value / max) * 100, 100) : 0}%` }}
        />
      </div>
    </div>
  );
}

const statusTones: Record<string, string> = {
  done: 'bg-ok-bg text-ok',
  running: 'bg-run-bg text-run',
  queued: 'bg-idle-bg text-idle',
  skipped: 'bg-wait-bg text-wait',
  paused: 'bg-wait-bg text-wait',
  failed: 'bg-err-bg text-err',
};
function StatusText({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusTones[status] ?? statusTones.queued}`}
    >
      {uk.tasks.status[status as keyof typeof uk.tasks.status] ?? status}
    </span>
  );
}
