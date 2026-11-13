'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listTelegramAccounts } from '@sonar/db/telegram';
import { uk } from '@/i18n/uk';
import { ChannelIcon } from './channel-icon';
import { StatusBadge } from './shared';
import { RowActions } from './ui/row-actions';
import { RevealValue, RevealToggle } from './ui/reveal-value';
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
  const [secretVisible, setSecretVisible] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', phone: '', dailyLimit: '' });
  const [login, setLogin] = useState<{
    id: string;
    step: 'code' | 'password';
  } | null>(null);
  const [delivery, setDelivery] = useState('');
  const [qr, setQr] = useState<{ id: string; image: string } | null>(null);
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
      setQr((current) =>
        result.step === 'qr'
          ? result.qr
            ? { id: result.id, image: result.qr }
            : current
          : null,
      );
      if (result.deliveryUk) setDelivery(result.deliveryUk);
      if (result.step === 'done') {
        setLogin(null);
        setForm({ name: '', phone: '', dailyLimit: '' });
      }
      if (method === 'DELETE' && 'id' in fields && fields.id === login?.id)
        setLogin(null);
      if (method === 'DELETE') setQr(null);
      // QR polls run every few seconds; re-render the page only when something changed.
      const polling = 'action' in fields && fields.action === 'qr-poll';
      if (!polling || result.step !== 'qr') router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      setSecret('');
      setSecretVisible(false);
      busy.current = false;
      setPending(false);
    }
  };
  // While a QR is shown, ask the server every few seconds whether it was scanned.
  const qrId = qr?.id;
  useEffect(() => {
    if (!qrId) return;
    const timer = setInterval(() => {
      if (!busy.current) void mutate('POST', { action: 'qr-poll', id: qrId });
    }, 4000);
    return () => clearInterval(timer);
    // mutate is recreated every render; polling depends only on the QR session.
  }, [qrId]);
  const startQr = () => {
    if (!form.name.trim() || !(Number(form.dailyLimit) >= 1)) {
      setError(uk.telegram.qrNeeds);
      return;
    }
    void mutate('POST', {
      action: 'qr',
      name: form.name,
      dailyLimit: Number(form.dailyLimit),
    });
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-heading text-base font-bold">
        <ChannelIcon channel="telegram" /> {uk.telegram.accounts}
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
              {account.name} ·{' '}
              <RevealValue
                value={account.fullAddress}
                masked={account.address}
                copy
              />
            </p>
            <p className="text-sm text-muted-foreground">
              {uk.email.today}: {account.sentToday} / {account.dailyLimit} ·{' '}
              <StatusBadge
                status={
                  account.status === 'disconnected'
                    ? 'disconnected'
                    : account.enabled
                      ? 'active'
                      : 'disabled'
                }
              >
                {account.status === 'disconnected'
                  ? uk.telegram.disconnected
                  : account.enabled
                    ? uk.email.enabled
                    : uk.email.disabled}
              </StatusBadge>
            </p>
            {account.status !== 'disconnected' && (
              <p className="text-xs text-muted-foreground">
                {uk.actions.session}: {uk.actions.savedSecret}
              </p>
            )}
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
            <RowActions
              disabled={pending}
              actions={[
                {
                  kind: account.enabled ? 'disable' : 'enable',
                  label: account.enabled ? uk.email.disable : uk.email.enable,
                  onSelect: () =>
                    void mutate('PATCH', {
                      id: account.id,
                      enabled: !account.enabled,
                    }),
                },
                {
                  kind: 'disconnect',
                  label: uk.telegram.disconnect,
                  danger: true,
                  onSelect: () => void mutate('DELETE', { id: account.id }),
                },
              ]}
            />
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
        {qr && !login ? (
          <div className="space-y-2 md:col-span-3">
            <img
              src={qr.image}
              alt={uk.telegram.qrAlt}
              width={240}
              height={240}
              className="rounded-lg bg-white p-2"
            />
            <p className="text-sm">{uk.telegram.qrHint}</p>
          </div>
        ) : login ? (
          <div className="md:col-span-3">
            <label htmlFor="telegram-secret">
              {login.step === 'code' ? uk.telegram.code : uk.telegram.password}
            </label>
            <Input
              id="telegram-secret"
              type={
                login.step === 'password' && !secretVisible
                  ? 'password'
                  : 'text'
              }
              inputMode={login.step === 'code' ? 'numeric' : undefined}
              autoComplete="off"
              required
              maxLength={login.step === 'code' ? 20 : 1024}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            {login.step === 'password' && secret && (
              <RevealToggle
                visible={secretVisible}
                onToggle={() => setSecretVisible(!secretVisible)}
              />
            )}
            {login.step === 'code' && delivery && (
              <p role="status" className="mt-2 text-sm">
                {delivery}
              </p>
            )}
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
          {!qr && (
            <Button disabled={pending || !configured}>
              {pending
                ? uk.ai.pending
                : login
                  ? uk.telegram.confirm
                  : uk.telegram.connect}
            </Button>
          )}
          {!login && !qr && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || !configured}
              onClick={startQr}
            >
              {uk.telegram.connectQr}
            </Button>
          )}
          {(login || qr) && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                void mutate('DELETE', { id: (login ?? qr)!.id });
                setSecret('');
                setSecretVisible(false);
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
