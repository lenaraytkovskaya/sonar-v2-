'use client';
import { useEffect, useState } from 'react';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
type Progress = {
  scanned: number;
  indexed: number;
  estimatedTotal: string | null;
  updatedAt: string | null;
  status: 'running' | 'done';
};
export function RegistryPhoneSync() {
  const { tasks, counts } = useTasks();
  const task = tasks.find((item) => item.type === 'registry.phones.sync');
  const status =
    counts.find(
      (item) =>
        item.type === 'registry.phones.sync' &&
        item.count > 0 &&
        ['queued', 'running', 'paused'].includes(item.status),
    )?.status ?? task?.status;
  const active = !!status && ['queued', 'running', 'paused'].includes(status);
  const [progress, setProgress] = useState<Progress | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/settings');
        if (!response.ok) throw Error(uk.tasks.error);
        const data = await response.json();
        if (!cancelled) {
          setProgress(data['registry.phones.progress'] ?? null);
          setError('');
        }
      } catch {
        if (!cancelled) setError(uk.tasks.error);
      }
    };
    void load();
    const timer = active ? setInterval(() => void load(), 5000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, status, task?.id]);
  const sync = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/settings/registry', {
        method: 'POST',
      });
      if (!response.ok)
        throw Error((await response.json()).error ?? uk.tasks.error);
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.tasks.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card className="space-y-3 p-6">
      <h2 className="font-heading text-xl font-bold">
        {uk.registry.syncTitle}
      </h2>
      <Button disabled={pending || !!active} onClick={() => void sync()}>
        {pending || active
          ? uk.tasks.status[
              status === 'running'
                ? 'running'
                : status === 'paused'
                  ? 'paused'
                  : 'queued'
            ]
          : uk.registry.sync}
      </Button>
      {progress && (
        <div role="status" className="space-y-1 text-sm text-muted-foreground">
          <p>
            {uk.registry.scanned}: {progress.scanned.toLocaleString('uk-UA')}
          </p>
          <p>
            {uk.registry.indexed}: {progress.indexed.toLocaleString('uk-UA')}
          </p>
          {progress.estimatedTotal && (
            <p>
              {uk.registry.total}: {progress.estimatedTotal}
            </p>
          )}
          {progress.updatedAt && (
            <p>
              {uk.registry.updated}:{' '}
              {new Date(progress.updatedAt).toLocaleString('uk-UA')}
            </p>
          )}
        </div>
      )}
      {task?.reason_uk && <p className="text-sm">{task.reason_uk}</p>}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
