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
  enrich = false,
}: {
  companyId: string;
  hasWebsite: boolean;
  enrich?: boolean;
}) {
  const router = useRouter();
  const { tasks } = useTasks();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const relevant = tasks.filter(
    (t) =>
      t.subject_id === companyId &&
      (enrich
        ? [
            'site.scan',
            'registry.match',
            'company.score',
            'company.analyze',
          ].includes(t.type)
        : t.type === 'site.scan'),
  );
  const active = relevant.find((t) => ['queued', 'running'].includes(t.status));
  const task = active ?? relevant[0];
  const completed = relevant
    .filter((t) => !['queued', 'running'].includes(t.status))
    .map((t) => `${t.id}:${t.status}`)
    .join(',');
  useEffect(() => {
    if (completed) router.refresh();
  }, [completed, router]);
  const scan = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        `/api/companies/${companyId}/${enrich ? 'enrich' : 'scan'}`,
        {
          method: 'POST',
        },
      );
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
    <div className="space-y-1 text-sm">
      <Button
        disabled={(!enrich && !hasWebsite) || pending || !!active}
        onClick={() => void scan()}
      >
        {pending || active
          ? uk.tasks.status[task?.status === 'running' ? 'running' : 'queued']
          : enrich
            ? uk.enrich.batch
            : uk.scanner.scan}
      </Button>
      {task && (
        <>
          <p>
            {uk.tasks.status[task.status as keyof typeof uk.tasks.status]}
            {task.reason_uk && ` · ${task.reason_uk}`}
          </p>
          {task.type === 'site.scan' && <ScanSummary result={task.result} />}
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
