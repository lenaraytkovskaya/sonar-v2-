'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { socialNetwork } from '@/lib/outreach-labels';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { CrudButton, CrudDialog } from './crud-dialog';
import { RowActions } from './ui/row-actions';

export function ManualEntry({
  companyId,
  campaigns = [],
  initialCampaignId = '',
}: {
  companyId?: string;
  campaigns?: { id: string; name: string; countryCode: string }[];
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
          countryCode: '',
          campaignId: initialCampaignId,
        },
  );
  const update = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (companyId || values.countryCode || !initialCampaignId) return;
    const campaign = campaigns.find((item) => item.id === initialCampaignId);
    if (campaign) update('countryCode', campaign.countryCode);
  }, [campaigns, companyId, initialCampaignId, values.countryCode]);
  const title = companyId ? uk.manual.addContact : uk.manual.addCompany;
  const fields = companyId
    ? ['value', 'note']
    : ['name', 'website', 'city', 'countryCode'];
  return (
    <div className="space-y-3">
      <CrudButton
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {title}
      </CrudButton>
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        pending={pending}
        draft={values}
        actions={
          <Button type="submit" form="manual-company-entry" disabled={pending}>
            {pending ? uk.ai.pending : title}
          </Button>
        }
      >
        <form
          id="manual-company-entry"
          className="space-y-4"
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
              } else {
                setOpen(false);
                router.push(
                  `/companies/${data.id}?campaignId=${values.campaignId}`,
                );
              }
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
                  } else if (companyId) update('kind', selected);
                  else {
                    const campaign = campaigns.find(
                      (item) => item.id === selected,
                    );
                    setValues((current) => ({
                      ...current,
                      campaignId: selected,
                      countryCode: campaign?.countryCode ?? '',
                    }));
                  }
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
        </form>
      </CrudDialog>
    </div>
  );
}

const editableKinds = [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
];

export function ContactActions({
  companyId,
  contact,
}: {
  companyId: string;
  contact: { id: string; kind: string; value: string; note: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    value: contact.value,
    note: contact.note,
  });
  const send = async (init: RequestInit, query = '') => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        `/api/companies/${companyId}/contacts${query}`,
        init,
      );
      if (!response.ok)
        throw Error((await response.json()).error ?? uk.ai.error);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.ai.error);
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <RowActions
        disabled={pending}
        actions={[
          ...(editableKinds.includes(contact.kind)
            ? [
                {
                  kind: 'edit' as const,
                  label: uk.manual.editContact,
                  onSelect: () => {
                    setError('');
                    setOpen(true);
                  },
                },
              ]
            : []),
          {
            kind: 'delete',
            label: uk.manual.deleteContact,
            danger: true,
            confirm: uk.actions.deleteContactConfirm,
            onSelect: async () => {
              if (await send({ method: 'DELETE' }, `?contactId=${contact.id}`))
                router.refresh();
            },
          },
        ]}
      />
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={uk.manual.editContact}
        pending={pending}
        draft={values}
        actions={
          <Button
            type="submit"
            form={`edit-contact-${contact.id}`}
            disabled={pending}
          >
            {pending ? uk.ai.pending : uk.manual.saveContact}
          </Button>
        }
      >
        <form
          id={`edit-contact-${contact.id}`}
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await send({
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactId: contact.id, ...values }),
              })
            ) {
              setOpen(false);
              router.refresh();
            }
          }}
        >
          <label>
            {uk.manual.fields.value}
            <Input
              className="min-h-[44px]"
              value={values.value}
              required
              maxLength={2000}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  value: event.target.value,
                }))
              }
            />
          </label>
          <div>
            <label>
              {uk.manual.fields.note}
              <Input
                className="min-h-[44px]"
                value={values.note}
                maxLength={2000}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
              />
            </label>
            <AiAssist
              text={values.note}
              onApply={(text) =>
                setValues((current) => ({ ...current, note: text }))
              }
            />
          </div>
          {error && (
            <p role="alert" className="text-err">
              {error}
            </p>
          )}
        </form>
      </CrudDialog>
      {error && !open && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </>
  );
}
