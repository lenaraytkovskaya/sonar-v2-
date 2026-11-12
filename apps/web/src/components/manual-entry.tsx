'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';

export function ManualEntry({
  companyId,
  campaigns = [],
  initialCampaignId = '',
}: {
  companyId?: string;
  campaigns?: { id: string; name: string }[];
  initialCampaignId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>(
    companyId
      ? { kind: 'email', value: '', note: '' }
      : {
          name: '',
          website: '',
          city: '',
          countryCode: 'UA',
          campaignId: initialCampaignId,
        },
  );
  const update = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const title = companyId ? uk.manual.addContact : uk.manual.addCompany;
  const fields = companyId
    ? ['value', 'note']
    : ['name', 'website', 'city', 'countryCode'];
  return (
    <div className="mb-4 space-y-3">
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {title}
      </Button>
      {open && (
        <form
          className="space-y-4 rounded-xl border border-border bg-surface p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError('');
            try {
              const response = await fetch(
                companyId
                  ? `/api/companies/${companyId}/contacts`
                  : '/api/companies',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(values),
                },
              );
              const data = await response.json();
              if (!response.ok) throw Error(data.error ?? uk.ai.error);
              if (companyId) {
                setValues({ kind: 'email', value: '', note: '' });
                setOpen(false);
                router.refresh();
              } else
                router.push(
                  `/companies/${data.id}?campaignId=${values.campaignId}`,
                );
            } catch (error) {
              setError(error instanceof Error ? error.message : uk.ai.error);
            } finally {
              setPending(false);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((key) => (
              <div key={key}>
                <label>
                  {uk.manual.fields[key as keyof typeof uk.manual.fields]}
                  <Input
                    value={values[key]}
                    required={['name', 'value', 'countryCode'].includes(key)}
                    maxLength={
                      key === 'countryCode'
                        ? 2
                        : key === 'name' || key === 'city'
                          ? 200
                          : 2000
                    }
                    onChange={(event) => update(key, event.target.value)}
                  />
                </label>
                {key !== 'value' && (
                  <AiAssist
                    text={values[key] ?? ''}
                    onApply={(text) => update(key, text)}
                  />
                )}
              </div>
            ))}
            <label>
              {companyId ? uk.company.type : uk.company.campaign}
              <select
                className="min-h-9 w-full rounded-lg border border-border bg-surface p-2"
                required
                value={values[companyId ? 'kind' : 'campaignId']}
                onChange={(event) =>
                  update(companyId ? 'kind' : 'campaignId', event.target.value)
                }
              >
                {companyId ? (
                  Object.entries(uk.manual.kinds).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="">{uk.manual.chooseCampaign}</option>
                    {campaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="text-err">
              {error}
            </p>
          )}
          <Button disabled={pending}>{pending ? uk.ai.pending : title}</Button>
        </form>
      )}
    </div>
  );
}

export function DeleteManualContact({
  companyId,
  contactId,
}: {
  companyId: string;
  contactId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="mt-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError('');
          try {
            const response = await fetch(
              `/api/companies/${companyId}/contacts?contactId=${contactId}`,
              { method: 'DELETE' },
            );
            if (!response.ok)
              throw Error((await response.json()).error ?? uk.ai.error);
            router.refresh();
          } catch (error) {
            setError(error instanceof Error ? error.message : uk.ai.error);
          } finally {
            setPending(false);
          }
        }}
      >
        {uk.manual.deleteContact}
      </Button>
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
