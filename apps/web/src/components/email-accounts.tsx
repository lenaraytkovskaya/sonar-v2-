'use client';
import { Fragment, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EmailAccount } from '@sonar/db/email';
import { uk } from '@/i18n/uk';
import { Card, StatusBadge } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { CrudButton, CrudDialog } from './crud-dialog';
import { RowActions } from './ui/row-actions';
import {
  HealthBadge,
  HealthDetails,
  HealthJournal,
  healthJournalAction,
  type AccountHealth,
} from './account-health';

export function EmailAccounts({
  accounts,
  health = [],
}: {
  accounts: EmailAccount[];
  health?: AccountHealth[];
}) {
  const router = useRouter(),
    busy = useRef(false);
  const [healthJournal, setHealthJournal] = useState<AccountHealth | null>(
    null,
  );
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <h2 className="font-heading text-base font-semibold">
          {uk.email.accounts}
        </h2>
        <CrudButton
          disabled={pending}
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {uk.email.add}
        </CrudButton>
      </div>
      {!accounts.length && <p>{uk.email.empty}</p>}
      {!!accounts.length && (
        <div className="min-w-0">
          <table className="block w-full text-left text-sm md:table">
            <thead className="hidden text-xs text-muted-foreground md:table-header-group">
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
                <Fragment key={account.id}>
                  <tr className="grid border-t border-border py-3 md:table-row md:py-0">
                    <td className="min-w-0 break-words py-2 md:p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {account.name}
                        <HealthBadge
                          health={health.find(
                            (item) => item.accountId === account.id,
                          )}
                        />
                      </div>
                    </td>
                    <td className="min-w-0 break-words py-2 md:p-3">
                      {account.fromAddress}
                    </td>
                    <td className="min-w-0 break-words py-2 md:p-3">
                      {account.ownerName ?? '—'}
                    </td>
                    <td className="min-w-0 break-words py-2 md:p-3">
                      {account.sentToday} / {account.dailyLimit}
                    </td>
                    <td className="min-w-0 break-words py-2 md:p-3">
                      {account.nextSendAt
                        ? new Date(account.nextSendAt).toLocaleString('uk-UA')
                        : '—'}
                    </td>
                    <td className="min-w-0 break-words py-2 md:p-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge
                          status={account.enabled ? 'active' : 'disabled'}
                        >
                          {account.enabled
                            ? uk.email.enabled
                            : uk.email.disabled}
                        </StatusBadge>
                        <RowActions
                          disabled={pending}
                          actions={[
                            ...healthJournalAction(
                              health.find(
                                (item) => item.accountId === account.id,
                              ),
                              setHealthJournal,
                            ),
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
                              confirm: `${uk.email.removeConfirm} ${account.fromAddress}?`,
                              onSelect: () => void remove(account.id),
                            },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                  <tr className="block md:table-row">
                    <td
                      colSpan={6}
                      className="block pb-4 md:table-cell md:px-3"
                    >
                      <HealthDetails
                        health={health.find(
                          (item) => item.accountId === account.id,
                        )}
                      />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <HealthJournal
        health={
          health.find((item) => item.accountId === healthJournal?.accountId) ??
          healthJournal
        }
        onClose={() => setHealthJournal(null)}
      />
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={uk.email.add}
        pending={pending}
        draft={form}
        actions={
          <Button type="submit" form="email-account-create" disabled={pending}>
            {pending ? uk.ai.pending : uk.email.add}
          </Button>
        }
      >
        <form
          id="email-account-create"
          className="grid gap-4 sm:grid-cols-2"
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

          {error && (
            <p role="alert" className="text-err sm:col-span-2">
              {error}
            </p>
          )}
        </form>
      </CrudDialog>
      {!open && error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
