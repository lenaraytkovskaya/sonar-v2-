'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FriendlyError } from './friendly-error';

type Company = { id: string; name: string; phones: string[] };

export function ViberThreadMatch({
  conversationId,
  active,
}: {
  conversationId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [contactId, setContactId] = useState('');
  const [phones, setPhones] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  if (!active) return null;
  const search = async () => {
    setError('');
    setCompanyId('');
    setContactId('');
    setPhones([]);
    try {
      const response = await fetch(
        `/api/companies?q=${encodeURIComponent(query.trim())}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw Error(uk.email.error);
      const data = await response.json();
      setCompanies(data.companies ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uk.email.error);
    }
  };
  const bind = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/viber-thread`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyId, contactId }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uk.email.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-2 border-b border-border p-3 text-sm">
      <p className="font-medium">{uk.viber.manualBinding}</p>
      <p className="text-muted-foreground">{uk.viber.manualBindingHint}</p>
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={uk.viber.searchCompany}
          aria-label={uk.viber.searchCompany}
        />
        <Button variant="outline" onClick={() => void search()}>
          {uk.viber.searchButton}
        </Button>
      </div>
      <select
        value={companyId}
        onChange={(event) => {
          const selected = companies.find(
            (company) => company.id === event.target.value,
          );
          setCompanyId(selected?.id ?? '');
          setContactId('');
          setPhones(selected?.phones ?? []);
        }}
        className="h-11 w-full rounded-md border border-border bg-background px-3"
        aria-label={uk.viber.searchCompany}
      >
        <option value="">{uk.viber.searchCompany}</option>
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
      </select>
      {companyId && (
        <select
          value={contactId}
          onChange={(event) => setContactId(event.target.value)}
          className="h-11 w-full rounded-md border border-border bg-background px-3"
          aria-label={uk.viber.choosePhone}
        >
          <option value="">{uk.viber.choosePhone}</option>
          {phones.map((phone) => (
            <option key={phone} value={phone}>
              {phone}
            </option>
          ))}
        </select>
      )}
      <Button
        disabled={pending || !companyId || !contactId}
        onClick={() => void bind()}
      >
        {uk.viber.bindThread}
      </Button>
      {error && <FriendlyError reason={error} />}
    </section>
  );
}
