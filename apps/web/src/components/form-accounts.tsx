'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listFormAccounts } from '@sonar/db/email';
import type { listManualFormMessages } from '@sonar/db/forms';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
type Account = Awaited<ReturnType<typeof listFormAccounts>>[number];
type Manual = Awaited<ReturnType<typeof listManualFormMessages>>;
const blank = {
  name: '',
  fromAddress: '',
  senderName: '',
  senderPhone: '',
  dailyLimit: '',
};
export function FormAccounts({
  accounts,
  manual,
}: {
  accounts: Account[];
  manual: Manual;
}) {
  const router = useRouter(),
    busy = useRef(false);
  const [form, setForm] = useState(blank),
    [editing, setEditing] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const mutate = async (url: string, data: object) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      setOpen(false);
      setEditing(null);
      setForm(blank);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <h2 className="font-heading text-base font-bold">
          {uk.forms.accounts}
        </h2>
        {!accounts.length && <p>{uk.forms.empty}</p>}
        {accounts.map((account) => (
          <section
            key={account.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
          >
            <div className="min-w-0 space-y-1 break-words">
              <p className="font-medium">
                {account.name} ·{' '}
                {account.enabled ? uk.email.enabled : uk.email.disabled}
              </p>
              <p>
                {account.senderName} · {account.fromAddress} ·{' '}
                {account.senderPhone}
              </p>
              <p className="text-sm text-muted-foreground">
                {uk.email.owner}: {account.ownerName ?? '—'} · {uk.email.today}:{' '}
                {account.sentToday} / {account.dailyLimit}
              </p>
              <p className="text-sm text-muted-foreground">
                {uk.email.next}:{' '}
                {account.nextSendAt
                  ? new Date(account.nextSendAt).toLocaleString('uk-UA')
                  : '—'}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setForm({
                  name: account.name,
                  fromAddress: account.fromAddress,
                  senderName: account.senderName,
                  senderPhone: account.senderPhone,
                  dailyLimit: String(account.dailyLimit),
                });
                setEditing(account.id);
                setOpen(true);
              }}
            >
              {uk.forms.edit}
            </Button>
          </section>
        ))}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            setEditing(null);
            setForm(blank);
            setOpen(true);
          }}
        >
          {uk.email.add}
        </Button>
        {open && (
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('/api/form-accounts', {
                ...form,
                id: editing,
                dailyLimit: Number(form.dailyLimit),
              });
            }}
          >
            {(
              [
                'name',
                'senderName',
                'fromAddress',
                'senderPhone',
                'dailyLimit',
              ] as const
            ).map((key) => (
              <div key={key}>
                <label htmlFor={'form-' + key}>
                  {
                    {
                      name: uk.email.name,
                      senderName: uk.forms.senderName,
                      fromAddress: uk.email.address,
                      senderPhone: uk.forms.senderPhone,
                      dailyLimit: uk.email.limit,
                    }[key]
                  }
                </label>
                <Input
                  id={'form-' + key}
                  required={key !== 'senderPhone'}
                  type={
                    key === 'dailyLimit'
                      ? 'number'
                      : key === 'fromAddress'
                        ? 'email'
                        : key === 'senderPhone'
                          ? 'tel'
                          : 'text'
                  }
                  min={key === 'dailyLimit' ? 1 : undefined}
                  step={key === 'dailyLimit' ? 1 : undefined}
                  maxLength={key === 'dailyLimit' ? undefined : 254}
                  value={form[key]}
                  onChange={(event) =>
                    setForm({ ...form, [key]: event.target.value })
                  }
                />
                <AiAssist
                  text={form[key]}
                  onApply={(text) => setForm({ ...form, [key]: text })}
                />
              </div>
            ))}
            <div className="flex gap-3 md:col-span-2">
              <Button disabled={pending}>
                {pending ? uk.ai.pending : uk.forms.save}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                {uk.forms.cancel}
              </Button>
            </div>
          </form>
        )}
      </Card>
      <Card className="space-y-4 p-5">
        <h2 className="font-heading text-base font-bold">{uk.forms.manual}</h2>
        <p className="text-sm text-muted-foreground">{uk.forms.manualHint}</p>
        {!manual.length && <p>{uk.forms.manualEmpty}</p>}
        {manual.map((message) => (
          <section
            key={message.id}
            className="space-y-3 border-t border-border pt-4"
          >
            <a
              className="font-medium text-accent"
              href={`/companies/${message.companyId}`}
            >
              {message.companyName}
            </a>
            <p>{message.reasonUk}</p>
            <p className="break-words">
              {message.senderName} · {message.senderEmail} ·{' '}
              {message.senderPhone}
            </p>
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <a href={message.url} target="_blank" rel="noreferrer">
                  {uk.forms.open}
                </a>
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  void mutate(`/api/form-messages/${message.id}`, {
                    action: 'sent',
                  })
                }
              >
                {uk.forms.markSent}
              </Button>
            </div>
          </section>
        ))}
      </Card>
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
