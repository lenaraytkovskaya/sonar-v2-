'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
export function ProzorroSearch({
  companyId,
  campaignId,
}: {
  companyId?: string;
  campaignId?: string;
}) {
  const router = useRouter(),
    { tasks } = useTasks();
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const task = tasks.find(
    (t) => t.type === 'prozorro.company' && t.subject_id === companyId,
  );
  const active = task && ['queued', 'running'].includes(task.status);
  useEffect(() => {
    if (task?.status && !['queued', 'running'].includes(task.status)) {
      setMessage('');
      router.refresh();
    }
  }, [task?.id, task?.status, router]);
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={pending || !!active}
        onClick={async () => {
          setPending(true);
          setMessage('');
          try {
            const response = await fetch(
              companyId
                ? `/api/companies/${companyId}/prozorro`
                : `/api/campaigns/${campaignId}/prozorro`,
              { method: 'POST' },
            );
            const data = await response.json();
            if (!response.ok) throw Error(data.error ?? uk.tasks.error);
            setMessage(
              campaignId
                ? `${uk.prozorro.queued}: ${data.count}`
                : data.created
                  ? uk.prozorro.queued
                  : `${uk.prozorro.todayTask}: ${uk.tasks.status[data.status as keyof typeof uk.tasks.status] ?? data.status}`,
            );
          } catch (error) {
            setMessage(error instanceof Error ? error.message : uk.tasks.error);
          } finally {
            setPending(false);
          }
        }}
      >
        {campaignId ? uk.prozorro.bulk : uk.prozorro.search}
      </Button>
      {(message || task?.reason_uk) && (
        <p role="status" className="text-xs text-muted-foreground">
          {task?.reason_uk || message}
        </p>
      )}
    </div>
  );
}
