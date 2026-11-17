'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RowActions } from './ui/row-actions';
import { uk } from '@/i18n/uk';

export function WhatsAppRetry({
  companyId,
  contactId,
}: {
  companyId: string;
  contactId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const retry = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        `/api/companies/${companyId}/whatsapp-retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      router.refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : uk.email.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <RowActions
        disabled={pending}
        actions={[
          {
            kind: 'retry',
            label: uk.whatsapp.retry,
            onSelect: () => void retry(),
          },
        ]}
      />
      {error && (
        <p role="alert" className="text-xs text-err">
          {error}
        </p>
      )}
    </>
  );
}
