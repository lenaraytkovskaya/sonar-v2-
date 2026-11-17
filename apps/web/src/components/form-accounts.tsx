'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listFormAccounts } from '@sonar/db/email';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { CrudButton, CrudDialog } from './crud-dialog';

type Account = Awaited<ReturnType<typeof listFormAccounts>>[number];
const blank = {
  name: '',
  dailyLimit: '',
};
export function FormAccounts({ accounts }: { accounts: Account[] }) {
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
        <h2 className="border-b border-border pb-4 font-heading text-base font-semibold">
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
            <CrudButton
              action="edit"
              aria-label={`${uk.forms.edit}: ${account.name}`}
              disabled={pending}
              onClick={() => {
                setError('');
                setForm({
                  name: account.name,
                  dailyLimit: String(account.dailyLimit),
                });
                setEditing(account.id);
                setOpen(true);
              }}
            >
              {uk.forms.edit}
            </CrudButton>
          </section>
        ))}
        <CrudButton
          disabled={pending}
          onClick={() => {
            setError('');
            setEditing(null);
            setForm(blank);
            setOpen(true);
          }}
        >
          {uk.email.add}
        </CrudButton>
        <CrudDialog
          open={open}
          onOpenChange={setOpen}
          title={editing ? uk.forms.edit : uk.email.add}
          pending={pending}
          draft={form}
          actions={
            <Button type="submit" form="form-account-save" disabled={pending}>
              {pending ? uk.ai.pending : uk.forms.save}
            </Button>
          }
        >
          <form
            id="form-account-save"
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
            {(['name', 'dailyLimit'] as const).map((key) => (
              <div key={key}>
                <label htmlFor={'form-' + key}>
                  {
                    {
                      name: uk.email.name,
                      dailyLimit: uk.email.limit,
                    }[key]
                  }
                </label>
                <Input
                  id={'form-' + key}
                  required
                  type={key === 'dailyLimit' ? 'number' : 'text'}
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

            {error && (
              <p role="alert" className="text-err md:col-span-2">
                {error}
              </p>
            )}
          </form>
        </CrudDialog>
      </Card>
      {!open && error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </div>
  );
}
