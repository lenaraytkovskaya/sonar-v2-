'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ManualExpenseCategory, ManualExpenseCurrency } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { AiAssist } from './ai-assist';
import { CrudButton, CrudDialog } from './crud-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { RowActions } from './ui/row-actions';

type Expense = {
  id: string;
  title: string;
  category: ManualExpenseCategory;
  amount: string;
  currency: ManualExpenseCurrency;
  amount_usd: string;
  rate_used: string;
  paid_on: string;
  paid_until: string | null;
  account_id: string | null;
  account_name: string | null;
  note: string;
};
type Account = { id: string; name: string };
type FormValue = {
  title: string;
  category: ManualExpenseCategory;
  amount: number;
  currency: ManualExpenseCurrency;
  paidOn: string;
  paidUntil: string;
  accountId: string;
  note: string;
};
const today = () => new Date().toISOString().slice(0, 10);
function nextMonth(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month!, 1));
  const lastDay = new Date(Date.UTC(year!, month! + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day!, lastDay));
  return next.toISOString().slice(0, 10);
}
const money = (value: string | number, currency: string) =>
  new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 4,
  }).format(Number(value));

export function ManualExpenses({
  month,
  expenses,
  accounts,
}: {
  month: string;
  expenses: Expense[];
  accounts: Account[];
}) {
  const router = useRouter();
  const id = useId();
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'edit' | 'continue'>('create');
  const [selected, setSelected] = useState<Expense | null>(null);
  const [form, setForm] = useState<FormValue>({
    title: '',
    category: 'other',
    amount: 0,
    currency: 'USD',
    paidOn: today(),
    paidUntil: '',
    accountId: '',
    note: '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const edit = (expense: Expense) => {
    setSelected(expense);
    setMode('edit');
    setForm({
      title: expense.title,
      category: expense.category,
      amount: Number(expense.amount),
      currency: expense.currency,
      paidOn: expense.paid_on,
      paidUntil: expense.paid_until ?? '',
      accountId: expense.account_id ?? '',
      note: expense.note,
    });
    setError('');
    setOpen(true);
  };
  const create = () => {
    setSelected(null);
    setMode('create');
    setForm({
      title: '',
      category: 'other',
      amount: 0,
      currency: 'USD',
      paidOn: today(),
      paidUntil: '',
      accountId: '',
      note: '',
    });
    setError('');
    setOpen(true);
  };
  const renew = (expense: Expense) => {
    setSelected(expense);
    setMode('continue');
    setForm({
      title: expense.title,
      category: expense.category,
      amount: Number(expense.amount),
      currency: expense.currency,
      paidOn: today(),
      paidUntil: nextMonth(expense.paid_until ?? today()),
      accountId: expense.account_id ?? '',
      note: expense.note,
    });
    setError('');
    setOpen(true);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const payload =
        mode === 'continue'
          ? {
              action: 'continue',
              id: selected?.id,
              amount: form.amount,
              currency: form.currency,
              paidOn: form.paidOn,
              paidUntil: form.paidUntil,
            }
          : {
              action: mode,
              ...(mode === 'edit' ? { id: selected?.id } : {}),
              title: form.title,
              category: form.category,
              amount: form.amount,
              currency: form.currency,
              paidOn: form.paidOn,
              paidUntil: form.paidUntil || null,
              accountId: form.accountId || null,
              note: form.note,
            };
      const response = await fetch('/api/manual-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? uk.finance.manualError);
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : uk.finance.manualError,
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const archive = async (expense: Expense) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const response = await fetch('/api/manual-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', id: expense.id }),
      });
      if (!response.ok) throw new Error(uk.finance.manualError);
      router.refresh();
    } catch {
      setError(uk.finance.manualError);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const set = <K extends keyof FormValue>(key: K, value: FormValue[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const categories: ManualExpenseCategory[] = [
    'proxy',
    'phone',
    'subscription',
    'other',
  ];
  const currencies: ManualExpenseCurrency[] = ['USD', 'UAH', 'EUR'];
  const title =
    mode === 'continue'
      ? uk.finance.continueTitle
      : mode === 'edit'
        ? uk.finance.manualEdit
        : uk.finance.manualAdd;
  return (
    <section className="mb-6 rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-base font-semibold">
          {uk.finance.manual}
        </h2>
        <CrudButton onClick={create}>{uk.finance.manualAdd}</CrudButton>
      </div>
      {error && !open && (
        <p role="alert" className="mb-3 text-sm text-err">
          {error}
        </p>
      )}
      {expenses.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr>
                {[
                  uk.finance.manualDate,
                  uk.finance.manualTitle,
                  uk.finance.category,
                  uk.finance.amount,
                  uk.finance.amountUsd,
                  uk.finance.paidUntil,
                  '',
                ].map((label, index) => (
                  <th key={`${label}-${index}`} className="p-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id} className="border-t border-border">
                  <td className="p-2 tabular-nums">{expense.paid_on}</td>
                  <td className="p-2">
                    <span className="block font-medium">{expense.title}</span>
                    {expense.account_name && (
                      <span className="text-xs text-muted-foreground">
                        {expense.account_name}
                      </span>
                    )}
                  </td>
                  <td className="p-2">
                    {uk.finance.categories[expense.category]}
                  </td>
                  <td className="p-2 tabular-nums">
                    {money(expense.amount, expense.currency)}
                  </td>
                  <td className="p-2 tabular-nums">
                    {money(expense.amount_usd, 'USD')}
                  </td>
                  <td className="p-2 tabular-nums">
                    {expense.paid_until ?? '—'}
                  </td>
                  <td className="p-1">
                    <RowActions
                      disabled={pending}
                      actions={[
                        {
                          kind: 'edit',
                          label: uk.finance.manualEdit,
                          onSelect: () => edit(expense),
                        },
                        ...(expense.paid_until
                          ? [
                              {
                                kind: 'retry' as const,
                                label: uk.finance.continue,
                                onSelect: () => renew(expense),
                              },
                            ]
                          : []),
                        {
                          kind: 'hide',
                          label: uk.finance.manualArchive,
                          onSelect: () => void archive(expense),
                          confirm: uk.finance.manualArchiveConfirm(
                            expense.title,
                          ),
                          danger: true,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {uk.finance.manualEmpty}
        </p>
      )}
      <CrudDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        pending={pending}
        draft={form}
        actions={
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={pending}
            className="min-h-11 whitespace-normal"
          >
            {mode === 'continue' ? uk.finance.continueSave : uk.finance.save}
          </Button>
        }
      >
        <form id={`${id}-form`} className="space-y-4" onSubmit={submit}>
          {mode !== 'continue' && (
            <>
              <label className="block space-y-1">
                <span>{uk.finance.manualTitle}</span>
                <Input
                  required
                  maxLength={200}
                  value={form.title}
                  onChange={(event) => set('title', event.target.value)}
                />
                <AiAssist
                  text={form.title}
                  onApply={(value) => set('title', value)}
                />
              </label>
              <label className="block space-y-1">
                <span>{uk.finance.category}</span>
                <select
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                  value={form.category}
                  onChange={(event) =>
                    set('category', event.target.value as ManualExpenseCategory)
                  }
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {uk.finance.categories[category]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span>{uk.finance.amount}</span>
              <Input
                type="number"
                min="0.0000000001"
                max="1000000000"
                step="any"
                required
                value={form.amount || ''}
                onChange={(event) => set('amount', event.target.valueAsNumber)}
              />
            </label>
            <label className="block space-y-1">
              <span>{uk.finance.currency}</span>
              <select
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                value={form.currency}
                onChange={(event) =>
                  set('currency', event.target.value as ManualExpenseCurrency)
                }
              >
                {currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span>{uk.finance.manualDate}</span>
              <Input
                type="date"
                required
                value={form.paidOn}
                onChange={(event) => set('paidOn', event.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span>{uk.finance.paidUntil}</span>
              <Input
                type="date"
                value={form.paidUntil}
                onChange={(event) => set('paidUntil', event.target.value)}
              />
            </label>
          </div>
          {mode !== 'continue' && (
            <>
              <label className="block space-y-1">
                <span>{uk.finance.account}</span>
                <select
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3"
                  value={form.accountId}
                  onChange={(event) => set('accountId', event.target.value)}
                >
                  <option value="">{uk.finance.noAccount}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span>{uk.finance.note}</span>
                <textarea
                  maxLength={4000}
                  rows={3}
                  value={form.note}
                  onChange={(event) => set('note', event.target.value)}
                  className="w-full rounded-lg border border-border bg-raised p-3 text-sm"
                />
                <AiAssist
                  text={form.note}
                  onApply={(value) => set('note', value)}
                />
              </label>
            </>
          )}
          {mode === 'continue' && (
            <p className="text-sm text-muted-foreground">
              {uk.finance.renewalDateHint}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
        </form>
      </CrudDialog>
      <span className="sr-only">{month}</span>
    </section>
  );
}
