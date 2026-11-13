'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { RowActions } from './ui/row-actions';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
import type { RegistryEntity } from '@sonar/core';
export function RegistryMatch({
  companyId,
  candidates = [],
}: {
  companyId: string;
  candidates?: RegistryEntity[];
}) {
  const router = useRouter();
  const { tasks } = useTasks();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const task = tasks.find(
    (t) => t.type === 'registry.match' && t.subject_id === companyId,
  );
  const active = task && ['queued', 'running'].includes(task.status);
  useEffect(() => {
    if (task?.status && !['queued', 'running'].includes(task.status))
      router.refresh();
  }, [task?.id, task?.status, router]);
  const run = async (
    action?: 'confirm' | 'reject',
    candidate?: RegistryEntity,
  ) => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/companies/${companyId}/registry`, {
        method: 'POST',
        ...(candidate && action
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action,
                candidate: { type: candidate.entity_type, id: candidate.id },
              }),
            }
          : {}),
      });
      if (!response.ok)
        throw Error((await response.json()).error ?? uk.tasks.error);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.tasks.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <Button disabled={pending || !!active} onClick={() => void run()}>
        {pending || active
          ? uk.tasks.status[task?.status === 'running' ? 'running' : 'queued']
          : uk.registry.find}
      </Button>
      {candidates.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold">{uk.registry.candidates}</h3>
          {candidates.map((candidate) => (
            <div
              className="space-y-2 rounded-lg border border-border p-3"
              key={`${candidate.entity_type}:${candidate.id}`}
            >
              <p className="break-words font-medium">
                {candidate.name ?? candidate.short_name}
              </p>
              <p className="break-words text-sm text-muted-foreground">
                {[candidate.edrpou, candidate.address, candidate.status]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending || !!active}
                  onClick={() => void run('confirm', candidate)}
                >
                  {uk.registry.confirm}
                </Button>
                <RowActions
                  disabled={pending || !!active}
                  actions={[
                    {
                      kind: 'hide',
                      label: uk.registry.reject,
                      onSelect: () => void run('reject', candidate),
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {task && !active && (
        <p className="text-sm text-muted-foreground">
          <StatusBadge status={task.status}>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
          </StatusBadge>
          {task.reason_uk && ` · ${task.reason_uk}`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
