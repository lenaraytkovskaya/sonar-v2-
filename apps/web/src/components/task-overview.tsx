'use client';
import Link from 'next/link';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { uk } from '@/i18n/uk';
import { Card, PageHeader } from '@/components/shared';
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
  }>({
    tasks: [],
    batches: [],
    failures: [],
    counts: [],
    sentToday: 0,
    unreadCount: 0,
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
      'ai.models': uk.tasks.aiModels,
      'ai.assist': uk.tasks.aiAssist,
      'ai.drafts': uk.outreach.generate,
      'ai.inbound': uk.inbound.classify,
      'ai.reply': uk.inbound.suggest,
      'email.receive': uk.inbound.received,
      'whatsapp.receive': uk.inbound.received,
      'google.batch': uk.google.title,
      'google.request': uk.google.title,
      'site.scan': uk.scanner.title,
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
    <>
      <PageHeader {...uk.pages.overview} />
      <Card className="mb-4 p-4 text-sm">
        {uk.email.sentToday}: <strong>{sentToday}</strong>
      </Card>
      {(error || retryError) && (
        <p role="alert" className="mb-4 text-err">
          {uk.tasks.error}
        </p>
      )}
      {batches.length > 0 && (
        <div className="mb-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {batches.slice(0, 6).map((batch) => (
            <Card key={batch.id} className="space-y-2 p-4 text-sm">
              <h2 className="font-heading text-base font-bold">
                {uk.google.title}: {batch.found_new + batch.found_known} /{' '}
                {batch.size}
              </h2>
              <p>
                {batch.campaign_name} ·{' '}
                {uk.tasks.status[batch.status as keyof typeof uk.tasks.status]}{' '}
                · ${Number(batch.cost_usd).toFixed(3)}
              </p>
              <progress
                className="w-full"
                aria-label={uk.google.title}
                value={batch.found_new + batch.found_known}
                max={batch.size}
              />
              <p className="text-sm text-muted-foreground">
                {batch.fixture ? uk.google.fixture : uk.google.estimated}
              </p>
              {batch.reason_uk && <p>{batch.reason_uk}</p>}
              {batch.companies > 0 && (
                <>
                  <p>
                    {uk.enrich.progress}: {batch.enriched} / {batch.companies}
                    {batch.enriching > 0 &&
                      ` · ${uk.enrich.running}: ${batch.enriching}`}
                  </p>
                  <progress
                    className="w-full"
                    aria-label={uk.enrich.progress}
                    value={batch.enriched}
                    max={batch.companies}
                  />
                </>
              )}
            </Card>
          ))}
        </div>
      )}
      <Card className="mb-4 p-4">
        <h2 className="mb-4 font-heading text-base font-bold">
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
                className="flex min-w-0 flex-wrap justify-between gap-2 break-words text-sm"
              >
                <span>
                  {name(task.type)}
                  {task.company_name && ` · ${task.company_name}`}
                  {task.reason_uk && (
                    <span className="block text-muted-foreground">
                      {task.reason_uk}
                    </span>
                  )}
                  {task.type === 'site.scan' && (
                    <ScanSummary result={task.result} />
                  )}
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
                <StatusText status={task.status} />
              </li>
            ))}
        </ul>
      </Card>
      <Card className="p-4">
        <h2 className="mb-4 font-heading text-base font-bold">
          {uk.tasks.failures}
        </h2>
        {failures.map((task) => (
          <div
            key={task.id}
            className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0"
          >
            <div className="min-w-0 flex-1 break-words">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {name(task.type)}
                <StatusText status={task.status} />
              </p>
              <p
                className={
                  task.status === 'paused'
                    ? 'text-sm text-wait'
                    : 'text-sm text-err'
                }
              >
                {task.reason_uk} · {uk.tasks.repetitions}: {task.repetitions}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending === task.id}
                onClick={() => void retry(task.id, 'dismiss')}
              >
                {uk.tasks.dismiss}
              </Button>
              {task.result?.billingPending ? (
                reconciling === task.id ? (
                  <>
                    <Button
                      disabled={pending === task.id}
                      onClick={() => void retry(task.id, 'reconcile', true)}
                    >
                      {uk.tasks.charged}
                    </Button>
                    <Button
                      disabled={pending === task.id}
                      onClick={() => void retry(task.id, 'reconcile', false)}
                    >
                      {uk.tasks.notCharged}
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setReconciling(task.id)}>
                    {uk.tasks.reconcile}
                  </Button>
                )
              ) : task.type.startsWith('whatsapp.account.') ? (
                <Button asChild>
                  <Link href="/channels">{uk.pages.channels.title}</Link>
                </Button>
              ) : (
                <Button
                  disabled={pending === task.id}
                  onClick={() => void retry(task.id)}
                >
                  {uk.tasks.retry}
                </Button>
              )}
            </div>
          </div>
        ))}
        {failures.length === 0 && (
          <p className="text-muted-foreground">{uk.tasks.noFailures}</p>
        )}
      </Card>
    </>
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
