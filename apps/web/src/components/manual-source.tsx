'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  manualSourceSchema,
  normalizeManualSource,
  ManualSourceError,
  type ManualSourceInput,
} from '@sonar/core';
import type { getManualSource } from '@sonar/db/companies';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { LocalTime } from './local-time';
import { CrudButton, CrudDialog } from './crud-dialog';

type Result = Awaited<ReturnType<typeof getManualSource>>;
function sourceError(error: unknown) {
  if (error instanceof ManualSourceError)
    return uk.manualSource.errors[error.code];
  const messages: readonly string[] = [
    ...Object.values(uk.manualSource.errors),
    uk.manualSource.error,
    uk.unauthorized,
    uk.ai.invalid,
    uk.tasks.error,
  ];
  return error instanceof Error && messages.includes(error.message)
    ? error.message
    : uk.manualSource.error;
}
export function ManualSource({
  companyId,
  source,
  current = null,
}: {
  companyId: string;
  source: ManualSourceInput['source'];
  current?: string | null;
}) {
  const router = useRouter(),
    id = useId(),
    submitting = useRef(false);
  const requestId = useRef<string | null>(null);
  const displayedRequest = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(''),
    [network, setNetwork] = useState<ManualSourceInput['network']>(),
    [reviewed, setReviewed] = useState<string | null | undefined>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Result>(null);
  const active = result?.tasks.some((t: { status: string }) =>
    ['queued', 'running'].includes(t.status),
  );
  const version = result?.requestId as string | undefined;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const startedAtRevision = revision.current;
      try {
        const query = new URLSearchParams({
          source,
          ...(version ? { requestId: version } : {}),
        });
        const response = await fetch(
          `/api/companies/${companyId}/sources?${query}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw Error();
        const next = await response.json();
        if (
          !controller.signal.aborted &&
          !submitting.current &&
          startedAtRevision === revision.current &&
          (!displayedRequest.current || displayedRequest.current === version)
        ) {
          displayedRequest.current = next?.requestId;
          setResult(next);
          if (
            active &&
            !next?.tasks.some((t: { status: string }) =>
              ['queued', 'running'].includes(t.status),
            )
          )
            router.refresh();
        }
      } catch {
        if (!controller.signal.aborted) setError(uk.manualSource.error);
      }
    };
    void load();
    const timer = active ? setInterval(() => void load(), 3000) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [companyId, source, version, active, router]);
  const edit = (text: string) => {
    setValue(text);
    setReviewed(undefined);
    requestId.current = null;
    setError('');
  };
  const submit = async () => {
    if (submitting.current) return;
    revision.current++;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      requestId.current ??= crypto.randomUUID();
      const input = manualSourceSchema.parse({
        requestId: requestId.current,
        source,
        value,
        network,
        expected: current,
      });
      normalizeManualSource(input);
      const response = await fetch(`/api/companies/${companyId}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.tasks.error);
      displayedRequest.current = data.requestId;
      setResult(data);
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(sourceError(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const replacement = current && ['website', 'googleMaps'].includes(source);
  const title = `${replacement ? uk.crud.edit : uk.campaign.add}: ${uk.manualSource.labels[source]}`;
  const retry = async (taskId: string) => {
    if (submitting.current) return;
    revision.current++;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${taskId}/retry`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok || !data.queued)
        throw Error(data.error ?? uk.tasks.error);
      setResult(
        (previous) =>
          previous && {
            ...previous,
            tasks: previous.tasks.map((task) =>
              task.id === taskId
                ? { ...task, status: 'queued', reason_uk: null }
                : task,
            ),
          },
      );
    } catch (error) {
      setError(sourceError(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <div className="space-y-3 border-t border-border pt-3 text-sm">
      <CrudButton
        action={replacement ? 'edit' : 'add'}
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {title}
      </CrudButton>
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        pending={pending}
        draft={{ value, network, reviewed }}
      >
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!replacement || reviewed === current) void submit();
          }}
        >
          <label htmlFor={id} className="block font-medium">
            {uk.manualSource.labels[source]}
          </label>
          <Input
            id={id}
            className="min-h-11"
            value={value}
            onChange={(event) => edit(event.target.value)}
            maxLength={2048}
            autoComplete="off"
            inputMode={source === 'registry' ? 'numeric' : 'text'}
            disabled={pending}
            required
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {uk.manualSource.hints[source]}
          </p>
          {source === 'social' && (
            <label className="block space-y-1">
              <span>{uk.manualSource.network}</span>
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                value={network ?? ''}
                disabled={pending}
                onChange={(event) => {
                  setNetwork(
                    (event.target.value as ManualSourceInput['network']) ||
                      undefined,
                  );
                  requestId.current = null;
                }}
              >
                <option value="">{uk.manualSource.fromUrl}</option>
                {(['facebook', 'instagram', 'linkedin'] as const).map((n) => (
                  <option key={n} value={n}>
                    {uk.social.networks[n]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {replacement && (
            <label className="flex min-h-11 items-start gap-2 break-all rounded-lg bg-raised p-2">
              <input
                className="mt-1 shrink-0"
                type="checkbox"
                checked={reviewed === current}
                onChange={(event) =>
                  setReviewed(event.target.checked ? current : undefined)
                }
                disabled={pending}
              />
              <span>
                {uk.manualSource.replace}: {current}
              </span>
            </label>
          )}
          <Button
            type="submit"
            disabled={
              pending ||
              !value.trim() ||
              (!!replacement && reviewed !== current)
            }
            className="min-h-11 w-full whitespace-normal sm:w-auto"
          >
            {pending ? uk.tasks.status.queued : uk.manualSource.submit}
          </Button>
        </form>
        <AiAssist text={value} onApply={edit} />
        {error && (
          <p role="alert" className="text-err">
            {error}
          </p>
        )}
      </CrudDialog>
      {!open && error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
      {result && (
        <div
          role="status"
          aria-live="polite"
          className="space-y-1 break-all rounded-lg bg-raised p-3"
        >
          <p>
            {uk.manualSource.saved}: {result.target} ·{' '}
            <LocalTime value={result.foundAt} />
          </p>
          {result.tasks.map(
            (task: {
              id: string;
              status: string;
              reason_uk: string | null;
              result: Record<string, unknown> | null;
            }) => (
              <div key={task.id}>
                <p>
                  {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
                  {task.reason_uk ? ` · ${task.reason_uk}` : ''}
                </p>
                {task.status === 'done' && (
                  <p className="text-xs text-muted-foreground">
                    {uk.manualSource.done}
                  </p>
                )}
                {['failed', 'paused', 'skipped'].includes(task.status) &&
                  task.result?.billingPending !== true && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void retry(task.id)}
                    >
                      {uk.tasks.retry}
                    </Button>
                  )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
