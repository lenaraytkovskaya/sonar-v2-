'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EmailAccount } from '@sonar/db/email';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
export function EmailAccounts({ accounts }: { accounts: EmailAccount[] }) {
  const router = useRouter(),
    busy = useRef(false);
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    fromAddress: '',
    dailyLimit: '',
  });
  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/email-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, dailyLimit: Number(form.dailyLimit) }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      setForm({ name: '', fromAddress: '', dailyLimit: '' });
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const remove = async (id: string, name: string) => {
    if (
      busy.current ||
      !window.confirm(uk.email.removeConfirm + ' ' + name + '?')
    )
      return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/email-accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const toggle = async (id: string, enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/email-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-heading text-base font-bold">{uk.email.accounts}</h2>
      {!accounts.length && <p>{uk.email.empty}</p>}
      {!!accounts.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  uk.email.name,
                  uk.email.address,
                  uk.email.owner,
                  uk.email.today,
                  uk.email.next,
                  uk.company.status,
                ].map((label) => (
                  <th key={label} className="p-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-t border-border">
                  <td className="p-3">{account.name}</td>
                  <td className="p-3">{account.fromAddress}</td>
                  <td className="p-3">{account.ownerName ?? '—'}</td>
                  <td className="p-3">
                    {account.sentToday} / {account.dailyLimit}
                  </td>
                  <td className="p-3">
                    {account.nextSendAt
                      ? new Date(account.nextSendAt).toLocaleString('uk-UA')
                      : '—'}
                  </td>
                  <td className="p-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          account.enabled
                            ? 'rounded-full bg-ok-bg px-2 py-0.5 text-xs text-ok'
                            : 'rounded-full bg-idle-bg px-2 py-0.5 text-xs text-idle'
                        }
                      >
                        {account.enabled ? uk.email.enabled : uk.email.disabled}
                      </span>
                      <Button
                        variant="outline"
                        className="min-h-7 px-2 text-xs"
                        disabled={pending}
                        onClick={() =>
                          void toggle(account.id, !account.enabled)
                        }
                      >
                        {account.enabled ? uk.email.disable : uk.email.enable}
                      </Button>
                      <Button
                        variant="outline"
                        className="min-h-7 px-2 text-xs"
                        disabled={pending}
                        onClick={() =>
                          void remove(account.id, account.fromAddress)
                        }
                      >
                        {uk.email.remove}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button variant="outline" onClick={() => setOpen(!open)}>
        {uk.email.add}
      </Button>
      {open && (
        <form
          className="grid gap-4 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {(['name', 'fromAddress', 'dailyLimit'] as const).map((key) => (
            <div key={key}>
              <label className="text-sm" htmlFor={'email-' + key}>
                {
                  uk.email[
                    {
                      name: 'name',
                      fromAddress: 'address',
                      dailyLimit: 'limit',
                    }[key] as 'name' | 'address' | 'limit'
                  ]
                }
              </label>
              <Input
                id={'email-' + key}
                required
                type={
                  key === 'dailyLimit'
                    ? 'number'
                    : key === 'fromAddress'
                      ? 'email'
                      : 'text'
                }
                min={key === 'dailyLimit' ? 1 : undefined}
                step={key === 'dailyLimit' ? 1 : undefined}
                maxLength={key === 'name' ? 200 : 320}
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
          <Button disabled={pending}>
            {pending ? uk.ai.pending : uk.email.add}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
