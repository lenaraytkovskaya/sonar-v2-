'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
export function WebsiteCandidate({
  companyId,
  factId,
}: {
  companyId: string;
  factId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const adopt = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/companies/${companyId}/website`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factId }),
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
    <div className="space-y-1">
      <Button variant="outline" disabled={pending} onClick={() => void adopt()}>
        {pending ? uk.tasks.status.queued : uk.company.adoptWebsite}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
    </div>
  );
}
