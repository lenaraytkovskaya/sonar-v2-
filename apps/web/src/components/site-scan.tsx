'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
import { ScanSummary } from './shared';
export function SiteScan({
  companyId,
  hasWebsite,
}: {
  companyId: string;
  hasWebsite: boolean;
}) {
  const router = useRouter();
  const { tasks } = useTasks();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const task = tasks.find(
    (t) => t.type === 'site.scan' && t.subject_id === companyId,
  );
  const active = task && ['queued', 'running'].includes(task.status);
  useEffect(() => {
    if (task?.status && !['queued', 'running'].includes(task.status))
      router.refresh();
  }, [task?.status, router]);
  const scan = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/companies/${companyId}/scan`, {
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
    <div className="mb-5 space-y-2">
      <Button
        disabled={!hasWebsite || pending || !!active}
        onClick={() => void scan()}
      >
        {pending || active
          ? uk.tasks.status[task?.status === 'running' ? 'running' : 'queued']
          : uk.scanner.scan}
      </Button>
      {task && (
        <>
          <p>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
            {task.reason_uk && ` · ${task.reason_uk}`}
          </p>
          <ScanSummary result={task.result} />
        </>
      )}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
