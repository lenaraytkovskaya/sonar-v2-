'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { listWhatsAppAccounts } from '@sonar/db/whatsapp';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';

type Account = Awaited<ReturnType<typeof listWhatsAppAccounts>>[number];
export function WhatsAppAccounts({
  accounts,
  configured,
}: {
  accounts: Account[];
  configured: boolean;
}) {
  const [current, setCurrent] = useState(accounts),
    [qr, setQr] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [name, setName] = useState(''),
    [limit, setLimit] = useState('');
  const busy = useRef(false),
    generation = useRef(0);
  const account = current[0];
  useEffect(() => {
    setCurrent(accounts);
  }, [accounts]);
  useEffect(() => {
    if (!account || !configured) return;
    const controller = new AbortController(),
      expected = generation.current;
    const load = async () => {
      if (busy.current) return;
      try {
        const response = await fetch('/api/whatsapp-accounts', {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh', id: account.id }),
        });
        const result = await response.json();
        if (controller.signal.aborted || expected !== generation.current)
          return;
        if (!response.ok) throw Error(result.error ?? uk.email.error);
        setCurrent(result.accounts);
        setQr(
          result.progress?.status === 'qr' ? (result.progress.qr ?? '') : '',
        );
        setError('');
      } catch (error) {
        if (!controller.signal.aborted && expected === generation.current) {
          setQr('');
          setError(error instanceof Error ? error.message : uk.email.error);
        }
      }
    };
    void load();
    const timer = ['qr', 'starting', 'active'].includes(account.status)
      ? setInterval(() => void load(), 5000)
      : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [account?.id, account?.status, configured, pollVersion]);
  const mutate = async (method: string, fields: object) => {
    if (busy.current) return;
    busy.current = true;
    generation.current++;
    setPending(true);
    setError('');
    setQr('');
    try {
      const response = await fetch('/api/whatsapp-accounts', {
        method,
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      setCurrent(result.accounts);
      setQr(result.progress?.status === 'qr' ? (result.progress.qr ?? '') : '');
    } catch (error) {
      setError(error instanceof Error ? error.message : uk.email.error);
    } finally {
      busy.current = false;
      setPending(false);
      setPollVersion((value) => value + 1);
    }
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-heading text-base font-bold">
        {uk.whatsapp.accounts}
      </h2>
      {!configured && <p role="status">{uk.whatsapp.configuration}</p>}
      <p className="text-sm text-muted-foreground">
        {uk.whatsapp.singleSession}
      </p>
      {account ? (
        <section className="space-y-4 border-t border-border pt-4">
          <div className="space-y-1 break-words">
            <p className="font-medium">
              {account.name}
              {account.providerName && ` · ${account.providerName}`}
              {account.address && ` · ${account.address}`}
            </p>
            <p className="text-sm text-muted-foreground">
              {uk.email.owner}: {account.ownerName}
            </p>
            <p role="status">
              {uk.whatsapp.statuses[account.status]}
              {account.status === 'active' &&
                ` · ${account.desiredEnabled ? uk.email.enabled : uk.email.disabled}`}
            </p>
            <p className="text-sm text-muted-foreground">
              {uk.email.today}: {account.sentToday} / {account.dailyLimit}
            </p>
            {account.nextSendAt && (
              <p className="text-sm text-muted-foreground">
                {uk.email.next}:{' '}
                {new Date(account.nextSendAt).toLocaleString('uk-UA')}
              </p>
            )}
            {account.reasonUk && <p className="text-err">{account.reasonUk}</p>}
          </div>
          {account.status === 'qr' && (
            <div className="space-y-3">
              <p>{uk.whatsapp.scan}</p>
              {qr ? (
                <Image
                  src={qr}
                  alt={uk.whatsapp.qr}
                  width={280}
                  height={280}
                  unoptimized
                  className="max-w-full rounded-lg bg-white p-3"
                />
              ) : (
                <p role="status">{uk.whatsapp.qrPending}</p>
              )}
            </div>
          )}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('PATCH', {
                id: account.id,
                dailyLimit: Number(limit || account.dailyLimit),
              });
            }}
          >
            <div>
              <label htmlFor="whatsapp-limit">{uk.email.limit}</label>
              <Input
                id="whatsapp-limit"
                className="w-32"
                type="number"
                min={1}
                step={1}
                required
                value={limit || account.dailyLimit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>
            <Button variant="outline" disabled={pending}>
              {uk.forms.save}
            </Button>
          </form>
          <div className="flex flex-wrap gap-3">
            {account.status === 'active' && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void mutate('PATCH', {
                    id: account.id,
                    enabled: !account.desiredEnabled,
                  })
                }
              >
                {account.desiredEnabled ? uk.email.disable : uk.email.enable}
              </Button>
            )}
            {['failed', 'stopped'].includes(account.status) && (
              <Button
                disabled={pending || !configured}
                onClick={() =>
                  void mutate('POST', { action: 'restart', id: account.id })
                }
              >
                {uk.whatsapp.restart}
              </Button>
            )}
            {account.status !== 'stopped' && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void mutate('DELETE', { id: account.id })}
              >
                {uk.whatsapp.disconnect}
              </Button>
            )}
          </div>
        </section>
      ) : (
        <>
          <p>{uk.whatsapp.empty}</p>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate('POST', {
                action: 'start',
                name,
                dailyLimit: Number(limit),
              });
            }}
          >
            <div>
              <label htmlFor="whatsapp-name">{uk.email.name}</label>
              <Input
                id="whatsapp-name"
                value={name}
                maxLength={200}
                required
                onChange={(event) => setName(event.target.value)}
              />
              <AiAssist text={name} onApply={setName} />
            </div>
            <div>
              <label htmlFor="whatsapp-new-limit">{uk.email.limit}</label>
              <Input
                id="whatsapp-new-limit"
                type="number"
                min={1}
                step={1}
                value={limit}
                required
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>
            <Button className="md:col-span-2" disabled={pending || !configured}>
              {pending ? uk.ai.pending : uk.whatsapp.connect}
            </Button>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
