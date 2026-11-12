'use client';
import { useEffect, useState } from 'react';
import { useTasks } from './task-overview';
import { Button } from './ui/button';
import { uk } from '@/i18n/uk';
function EnrichButton({ batchId }: { batchId: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>(
    'idle',
  );
  const [count, setCount] = useState(0);
  const run = async () => {
    setState('pending');
    try {
      const response = await fetch(`/api/batches/${batchId}/enrich`, {
        method: 'POST',
      });
      if (!response.ok) throw Error();
      setCount((await response.json()).companies);
      setState('done');
    } catch {
      setState('error');
    }
  };
  return (
    <div className="space-y-1">
      <Button disabled={state === 'pending'} onClick={() => void run()}>
        {uk.enrich.batch}
      </Button>
      {state === 'done' && (
        <p className="text-sm text-muted-foreground">
          {uk.enrich.queued}: {count}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-sm text-err">
          {uk.tasks.error}
        </p>
      )}
    </div>
  );
}
type Batch = {
  id: string;
  number: number;
  status: keyof typeof uk.tasks.status;
  found_new: number;
  found_known: number;
  requests: number;
  cost_usd: string;
  reason_uk: string | null;
  fixture: boolean;
};
export function BatchList({ campaignId }: { campaignId: string }) {
  const { batches: progress } = useTasks();
  const [batches, setBatches] = useState<Batch[]>([]),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/campaigns/${campaignId}/batches`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        setBatches((await r.json()).batches);
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [campaignId, progress]);
  return (
    <section className="mt-6 space-y-3">
      <h2 className="font-heading text-base font-bold">{uk.company.batches}</h2>
      {error && <p role="alert">{uk.ai.error}</p>}
      {loading && !batches.length && <p>{uk.google.loading}</p>}
      {!loading && !batches.length && !error && <p>{uk.company.noBatches}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {[
                uk.company.batch,
                uk.company.status,
                uk.company.found,
                uk.company.new,
                uk.company.known,
                uk.company.requests,
                uk.company.cost,
                uk.enrich.progress,
              ].map((label) => (
                <th className="p-2" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-t border-border">
                <td className="p-2">#{b.number}</td>
                <td className="p-2">
                  {uk.tasks.status[b.status]}
                  {b.reason_uk && <p>{b.reason_uk}</p>}
                  {b.fixture && <p>{uk.google.fixture}</p>}
                </td>
                <td className="p-2">{b.found_new + b.found_known}</td>
                <td className="p-2">{b.found_new}</td>
                <td className="p-2">{b.found_known}</td>
                <td className="p-2">{b.requests}</td>
                <td className="p-2">{Number(b.cost_usd).toFixed(3)}</td>
                <td className="p-2">
                  {b.status === 'done' && <EnrichButton batchId={b.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">{uk.google.estimated}</p>
    </section>
  );
}
