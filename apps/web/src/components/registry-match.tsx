'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
export function RegistryMatch({ companyId }: { companyId: string }) {
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
  }, [task?.status, router]);
  const run = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/companies/${companyId}/registry`, {
        method: 'POST',
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
      {task && !active && (
        <p className="text-sm text-muted-foreground">
          {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
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
