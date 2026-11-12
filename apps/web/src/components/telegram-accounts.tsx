'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listTelegramAccounts } from '@sonar/db/telegram';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';

type Account = Awaited<ReturnType<typeof listTelegramAccounts>>[number];
export function TelegramAccounts({
  accounts,
  configured,
}: {
  accounts: Account[];
  configured: boolean;
}) {
  const router = useRouter(),
    busy = useRef(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', phone: '', dailyLimit: '' });
  const [login, setLogin] = useState<{
    id: string;
    step: 'code' | 'password';
  } | null>(null);
  const [secret, setSecret] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const mutate = async (method: string, fields: object) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/telegram-accounts', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      if (result.step === 'code' || result.step === 'password')
        setLogin({ id: result.id, step: result.step });
      if (result.step === 'done') {
        setLogin(null);
        setForm({ name: '', phone: '', dailyLimit: '' });
      }
      if (method === 'DELETE' && 'id' in fields && fields.id === login?.id)
        setLogin(null);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      setSecret('');
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-heading text-base font-bold">
        {uk.telegram.accounts}
      </h2>
      {!configured && <p role="status">{uk.telegram.configuration}</p>}
      {!accounts.length && <p>{uk.telegram.empty}</p>}
      {accounts.map((account) => (
        <section
          key={account.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
        >
          <div className="min-w-0 space-y-1 break-words">
            <p className="font-medium">
              {account.name} · {account.address}
            </p>
            <p className="text-sm text-muted-foreground">
              {uk.email.today}: {account.sentToday} / {account.dailyLimit} ·{' '}
              {account.status === 'disconnected'
                ? uk.telegram.disconnected
                : account.enabled
                  ? uk.email.enabled
                  : uk.email.disabled}
            </p>
            {account.nextSendAt && (
              <p className="text-sm text-muted-foreground">
                {uk.email.next}:{' '}
                {new Date(account.nextSendAt).toLocaleString('uk-UA')}
              </p>
            )}
          </div>
          {account.status !== 'disconnected' && (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate('PATCH', {
                  id: account.id,
                  dailyLimit: Number(limits[account.id] ?? account.dailyLimit),
                });
              }}
            >
              <div>
                <label htmlFor={'telegram-limit-' + account.id}>
                  {uk.email.limit}
                </label>
                <Input
                  id={'telegram-limit-' + account.id}
                  className="w-32"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={limits[account.id] ?? account.dailyLimit}
                  onChange={(event) =>
                    setLimits({ ...limits, [account.id]: event.target.value })
                  }
                />
              </div>
              <Button variant="outline" disabled={pending}>
                {uk.forms.save}
              </Button>
            </form>
          )}
          {account.status !== 'disconnected' && (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void mutate('PATCH', {
                    id: account.id,
                    enabled: !account.enabled,
                  })
                }
              >
                {account.enabled ? uk.email.disable : uk.email.enable}
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void mutate('DELETE', { id: account.id })}
              >
                {uk.telegram.disconnect}
              </Button>
            </div>
          )}
        </section>
      ))}
      <form
        className="grid gap-4 md:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            'POST',
            login
              ? { action: 'complete', id: login.id, [login.step]: secret }
              : {
                  action: 'start',
                  ...form,
                  dailyLimit: Number(form.dailyLimit),
                },
          );
        }}
      >
        {login ? (
          <div className="md:col-span-3">
            <label htmlFor="telegram-secret">
              {login.step === 'code' ? uk.telegram.code : uk.telegram.password}
            </label>
            <Input
              id="telegram-secret"
              type={login.step === 'password' ? 'password' : 'text'}
              inputMode={login.step === 'code' ? 'numeric' : undefined}
              autoComplete="off"
              required
              maxLength={login.step === 'code' ? 20 : 1024}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <p className="mt-2 text-sm text-muted-foreground">
              {uk.telegram.secretHint}
            </p>
          </div>
        ) : (
          (['name', 'phone', 'dailyLimit'] as const).map((key) => (
            <div key={key}>
              <label htmlFor={'telegram-' + key}>
                {
                  {
                    name: uk.email.name,
                    phone: uk.telegram.phone,
                    dailyLimit: uk.email.limit,
                  }[key]
                }
              </label>
              <Input
                id={'telegram-' + key}
                required
                type={
                  key === 'dailyLimit'
                    ? 'number'
                    : key === 'phone'
                      ? 'tel'
                      : 'text'
                }
                min={key === 'dailyLimit' ? 1 : undefined}
                step={key === 'dailyLimit' ? 1 : undefined}
                maxLength={200}
                value={form[key]}
                onChange={(event) =>
                  setForm({ ...form, [key]: event.target.value })
                }
              />
              {key === 'name' && (
                <AiAssist
                  text={form[key]}
                  onApply={(text) => setForm({ ...form, [key]: text })}
                />
              )}
            </div>
          ))
        )}
        <div className="flex gap-3 md:col-span-3">
          <Button disabled={pending || !configured}>
            {pending
              ? uk.ai.pending
              : login
                ? uk.telegram.confirm
                : uk.telegram.connect}
          </Button>
          {login && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                void mutate('DELETE', { id: login.id });
                setSecret('');
              }}
            >
              {uk.forms.cancel}
            </Button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
