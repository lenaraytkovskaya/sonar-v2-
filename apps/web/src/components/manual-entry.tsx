'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { socialNetwork } from '@/lib/outreach-labels';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { RowActions } from './ui/row-actions';

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
  const [network, setNetwork] =
    useState<keyof typeof uk.social.networks>('instagram');
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
          <div
            className={companyId ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}
          >
            <label>
              {companyId ? uk.company.type : uk.company.campaign}
              <select
                className="min-h-[44px] w-full rounded-lg border border-border bg-surface p-2"
                required
                value={
                  companyId && values.kind === 'social'
                    ? network
                    : values[companyId ? 'kind' : 'campaignId']
                }
                onChange={(event) => {
                  const selected = event.target.value;
                  if (companyId && selected in uk.social.networks) {
                    if (values.kind !== 'social' || selected !== network)
                      update('value', '');
                    setNetwork(selected as keyof typeof uk.social.networks);
                    update('kind', 'social');
                  } else update(companyId ? 'kind' : 'campaignId', selected);
                }}
              >
                {companyId ? (
                  Object.entries(uk.manual.kinds).flatMap(([kind, label]) =>
                    kind === 'social' ? (
                      Object.entries(uk.social.networks).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))
                    ) : (
                      <option key={kind} value={kind}>
                        {label}
                      </option>
                    ),
                  )
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
            {fields.map((key) => (
              <div key={key}>
                <label>
                  {key === 'value' && values.kind === 'social'
                    ? `${uk.manual.socialProfile} · ${uk.social.networks[network]}`
                    : uk.manual.fields[key as keyof typeof uk.manual.fields]}
                  <Input
                    className="min-h-[44px]"
                    value={values[key]}
                    placeholder={
                      key === 'value'
                        ? values.kind === 'social'
                          ? uk.manual.socialPlaceholders[network]
                          : uk.manual.contactPlaceholders[
                              values.kind as keyof typeof uk.manual.contactPlaceholders
                            ]
                        : uk.manual.placeholders[
                            key as keyof typeof uk.manual.placeholders
                          ]
                    }
                    required={['name', 'value', 'countryCode'].includes(key)}
                    maxLength={
                      key === 'countryCode'
                        ? 2
                        : key === 'name' || key === 'city'
                          ? 200
                          : 2000
                    }
                    onChange={(event) => {
                      update(key, event.target.value);
                      if (key === 'value' && values.kind === 'social') {
                        const detected = socialNetwork(event.target.value);
                        if (detected) setNetwork(detected);
                      }
                    }}
                  />
                </label>
                {key === 'value' && values.kind === 'social' && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {uk.manual.socialHint}
                  </p>
                )}
                {key !== 'value' && (
                  <AiAssist
                    text={values[key] ?? ''}
                    onApply={(text) => update(key, text)}
                  />
                )}
              </div>
            ))}
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
    <div>
      <RowActions
        disabled={pending}
        actions={[
          {
            kind: 'delete',
            label: uk.manual.deleteContact,
            danger: true,
            confirm: uk.actions.deleteContactConfirm,
            onSelect: () => {
              void (async () => {
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
                  setError(
                    error instanceof Error ? error.message : uk.ai.error,
                  );
                } finally {
                  setPending(false);
                }
              })();
            },
          },
        ]}
      />
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
