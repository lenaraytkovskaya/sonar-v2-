'use client';
import { useEffect, useState } from 'react';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { StatusBadge } from './shared';
import { useTasks } from './task-overview';

type RunState = {
  status: keyof typeof uk.campaign.statuses;
  budget: number;
  spent: number;
  active: number;
  held: number;
};

export function CampaignRunCard({
  campaignId,
  status,
  pending,
  startDisabled,
  startLabel,
  onStart,
  onScore,
  onChanged,
}: {
  campaignId: string;
  status: keyof typeof uk.campaign.statuses;
  pending: boolean;
  startDisabled: boolean;
  startLabel: string;
  onStart: () => void;
  onScore: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = uk.campaign.run;
  const { batches } = useTasks();
  const [state, setState] = useState<RunState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/campaigns/${campaignId}/run`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error();
        setState(await response.json());
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [campaignId, status, batches]);
  const change = async (action: 'pause' | 'resume') => {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw Error();
      setConfirming(false);
      await onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={t.title}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-heading text-base font-bold">{t.title}</h3>
        <StatusBadge status={status}>
          {uk.campaign.statuses[status]}
        </StatusBadge>
      </div>
      <p className="text-sm text-muted-foreground">
        {status === 'paused'
          ? `${t.pausedHint} ${t.held}: ${state?.held ?? 0}.`
          : status === 'active'
            ? `${t.activeHint} ${t.inProgress}: ${state?.active ?? 0}.`
            : t.draftHint}
      </p>
      {state && state.budget > 0 && (
        <p className="text-sm text-muted-foreground">
          {t.spent}: ${state.spent.toFixed(2)} / ${state.budget.toFixed(2)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {status === 'paused' ? (
          <Button disabled={busy} onClick={() => void change('resume')}>
            {t.resume}
          </Button>
        ) : (
          <Button disabled={pending || startDisabled} onClick={onStart}>
            {startLabel}
          </Button>
        )}
        <Button variant="outline" disabled={pending} onClick={onScore}>
          {uk.campaign.recalculate}
        </Button>
        {status === 'active' && !confirming && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {uk.campaign.pause}
          </Button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={t.confirmTitle}
          className="space-y-3 rounded-lg bg-chip p-3 text-sm"
        >
          <p className="font-medium">{t.confirmTitle}</p>
          <p>{t.confirmBody}</p>
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void change('pause')}>
              {t.confirm}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t.cancel}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-err">
          {uk.tasks.error}
        </p>
      )}
    </section>
  );
}
