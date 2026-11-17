'use client';
import { prozorroCode } from '@sonar/core';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { useTasks } from './task-overview';
import { CrudButton, CrudDialog } from './crud-dialog';
import { FriendlyError } from './friendly-error';

export function ProzorroSearch({
  companyId,
  campaignId,
  allowManualCode = false,
}: {
  companyId?: string;
  campaignId?: string;
  allowManualCode?: boolean;
}) {
  const router = useRouter(),
    { tasks } = useTasks();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(''),
    [code, setCode] = useState('');
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
  const search = async (manualCode?: string) => {
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(
        companyId
          ? `/api/companies/${companyId}/prozorro`
          : `/api/campaigns/${campaignId}/prozorro`,
        {
          method: 'POST',
          ...(manualCode
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: manualCode }),
              }
            : {}),
        },
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
      if (manualCode) {
        setOpen(false);
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uk.tasks.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={pending || !!active}
        onClick={() => void search()}
      >
        {campaignId ? uk.prozorro.bulk : uk.prozorro.search}
      </Button>
      {companyId && allowManualCode && (
        <>
          <CrudButton
            disabled={pending || !!active}
            onClick={() => {
              setMessage('');
              setOpen(true);
            }}
          >
            {uk.crud.addCode}
          </CrudButton>
          <CrudDialog
            open={open}
            onOpenChange={setOpen}
            title={uk.crud.addCode}
            pending={pending}
            draft={code}
            actions={
              <Button
                disabled={pending || !!active || !prozorroCode(code)}
                onClick={() => void search(code)}
              >
                {uk.prozorro.saveCodeSearch}
              </Button>
            }
          >
            <div className="space-y-2">
              <label className="block space-y-1">
                <span>{uk.prozorro.companyCode}</span>
                <Input
                  className="min-h-11"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={10}
                  value={code}
                  disabled={pending || !!active}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {uk.prozorro.manualCodeHint}
              </p>
              <AiAssist text={code} onApply={setCode} />
              {message && (
                <p role="status" className="text-sm">
                  {message}
                </p>
              )}
            </div>
          </CrudDialog>
        </>
      )}
      {!open && (message || task?.reason_uk) && (
        <p role="status" className="text-xs text-muted-foreground">
          {message ||
            (task?.reason_uk && <FriendlyError reason={task.reason_uk} />)}
        </p>
      )}
    </div>
  );
}
