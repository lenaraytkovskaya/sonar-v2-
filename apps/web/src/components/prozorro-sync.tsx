'use client';
import { useEffect, useState } from 'react';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
type Progress = {
  documents: number;
  rows: number;
  cursorDate: string | null;
  status: keyof typeof uk.tasks.status;
  reasonUk?: string | null;
};
type SyncState = {
  'prozorro.enabled'?: boolean;
  'prozorro.tender.progress'?: Progress;
  'prozorro.contract.progress'?: Progress;
};
export function ProzorroSync() {
  const [data, setData] = useState<SyncState>({}),
    [pending, setPending] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/settings', {
          signal: controller.signal,
        });
        if (!response.ok) throw Error();
        setData(await response.json());
        setLoaded(true);
        setError('');
      } catch {
        if (!controller.signal.aborted) setError(uk.tasks.error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const act = async (action: 'start' | 'pause') => {
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/settings/prozorro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok)
        throw Error((await response.json()).error ?? uk.tasks.error);
      setData(await response.json());
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.tasks.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card className="space-y-4 p-6">
      <h2 className="font-heading text-base font-bold">{uk.prozorro.title}</h2>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!loaded || pending || data['prozorro.enabled'] === true}
          onClick={() => void act('start')}
        >
          {uk.prozorro.start}
        </Button>
        <Button
          variant="outline"
          disabled={!loaded || pending || data['prozorro.enabled'] !== true}
          onClick={() => void act('pause')}
        >
          {uk.prozorro.pause}
        </Button>
      </div>
      <div role="status" className="grid gap-4 sm:grid-cols-2">
        {(['tender', 'contract'] as const).map((feed) => {
          const progress = data[`prozorro.${feed}.progress`];
          return (
            <section key={feed} className="space-y-1 text-sm">
              <h3 className="font-semibold">{uk.prozorro[feed]}</h3>
              <p>
                {
                  uk.tasks.status[
                    data['prozorro.enabled'] === false
                      ? 'paused'
                      : (progress?.status ?? 'queued')
                  ]
                }
              </p>
              <p>
                {uk.prozorro.documents}:{' '}
                {(progress?.documents ?? 0).toLocaleString('uk-UA')}
              </p>
              <p>
                {uk.prozorro.rows}:{' '}
                {(progress?.rows ?? 0).toLocaleString('uk-UA')}
              </p>
              <p>
                {uk.prozorro.cursorDate}:{' '}
                {progress?.cursorDate
                  ? new Date(progress.cursorDate).toLocaleString('uk-UA')
                  : '—'}
              </p>
              {data['prozorro.enabled'] === false ? (
                <p>{progress?.reasonUk ?? uk.prozorro.paused}</p>
              ) : (
                progress?.reasonUk && <p>{progress.reasonUk}</p>
              )}
            </section>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
