'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EmailAccount } from '@sonar/db/email';
import { uk } from '@/i18n/uk';
import { ChannelIcon } from './channel-icon';
import { StatusBadge } from './shared';
import { RowActions } from './ui/row-actions';
import { RevealValue } from './ui/reveal-value';
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
  const remove = async (id: string) => {
    if (busy.current) return;
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
      <h2 className="font-heading text-base font-bold">
        <ChannelIcon channel="email" /> {uk.email.accounts}
      </h2>
      {!accounts.length && <p>{uk.email.empty}</p>}
      {!!accounts.length && (
        <div className="overflow-x-auto">
          <table className="block w-full text-left text-sm md:table">
            <thead className="hidden md:table-header-group">
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
            <tbody className="block md:table-row-group">
              {accounts.map((account) => (
                <tr
                  key={account.id}
                  className="grid grid-cols-2 gap-2 border-t border-border py-3 md:table-row md:py-0"
                >
                  <td
                    data-label={uk.email.name}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    {account.name}
                  </td>
                  <td
                    data-label={uk.email.address}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    <RevealValue value={account.fromAddress} copy />
                  </td>
                  <td
                    data-label={uk.email.owner}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    {account.ownerName ?? '—'}
                  </td>
                  <td
                    data-label={uk.email.today}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    {account.sentToday} / {account.dailyLimit}
                  </td>
                  <td
                    data-label={uk.email.next}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    {account.nextSendAt
                      ? new Date(account.nextSendAt).toLocaleString('uk-UA')
                      : '—'}
                  </td>
                  <td
                    data-label={uk.company.status}
                    className="min-w-0 p-1 before:block before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:p-3 md:before:hidden"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        status={account.enabled ? 'active' : 'disabled'}
                      >
                        {account.enabled ? uk.email.enabled : uk.email.disabled}
                      </StatusBadge>
                      <RowActions
                        disabled={pending}
                        actions={[
                          {
                            kind: account.enabled ? 'disable' : 'enable',
                            label: account.enabled
                              ? uk.email.disable
                              : uk.email.enable,
                            onSelect: () =>
                              void toggle(account.id, !account.enabled),
                          },
                          {
                            kind: 'delete',
                            label: uk.email.remove,
                            danger: true,
                            confirm:
                              uk.email.removeConfirm +
                              ' ' +
                              account.fromAddress +
                              '?',
                            onSelect: () => void remove(account.id),
                          },
                        ]}
                      />
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
