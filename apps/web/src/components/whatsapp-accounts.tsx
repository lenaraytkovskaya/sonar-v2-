'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import type { listWhatsAppAccounts } from '@sonar/db/whatsapp';
import { uk } from '@/i18n/uk';
import { Card, StatusBadge } from './shared';
import { ChannelIcon } from './channel-icon';
import { DetailList, InfoTip } from './ui/layout';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { CrudButton, CrudDialog } from './crud-dialog';
import { RevealValue } from './ui/reveal-value';
import { FriendlyError } from './friendly-error';
import { RowActions } from './ui/row-actions';
import {
  HealthBadge,
  HealthDetails,
  HealthJournal,
  healthJournalAction,
  type AccountHealth,
} from './account-health';

type Account = Awaited<ReturnType<typeof listWhatsAppAccounts>>[number];
export function WhatsAppAccounts({
  accounts,
  health = [],
  configured,
}: {
  accounts: Account[];
  health?: AccountHealth[];
  configured: boolean;
}) {
  const router = useRouter();
  const [healthJournal, setHealthJournal] = useState<AccountHealth | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const healthPaused = health.some(
    (item) => item.accountId === account?.id && item.pauseUntil,
  );
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
      router.refresh();
      if (method === 'PATCH' && 'dailyLimit' in fields) setEditing(false);
      if (method === 'POST' && 'action' in fields && fields.action === 'start')
        setOpen(false);
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
      <HealthJournal
        health={
          health.find((item) => item.accountId === healthJournal?.accountId) ??
          healthJournal
        }
        onClose={() => setHealthJournal(null)}
      />
      <h2 className="border-b border-border pb-4 font-heading text-base font-semibold">
        {uk.whatsapp.accounts}
      </h2>
      {!configured && <p role="status">{uk.whatsapp.configuration}</p>}
      {account ? (
        <article className="space-y-4 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chip">
                <ChannelIcon channel="whatsapp" />
              </span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{account.name}</h3>
                  <StatusBadge
                    status={
                      {
                        active: account.desiredEnabled ? 'active' : 'disabled',
                        qr: 'queued',
                        starting: 'running',
                        failed: 'failed',
                        stopped: 'disabled',
                      }[account.status]
                    }
                  >
                    {uk.whatsapp.statuses[account.status]}
                  </StatusBadge>
                  <HealthBadge
                    health={health.find(
                      (item) => item.accountId === account.id,
                    )}
                  />
                  <InfoTip>{uk.whatsapp.singleSession}</InfoTip>
                  <InfoTip label={uk.whatsapp.repairWebhook}>
                    {uk.whatsapp.repairWebhookHint}
                  </InfoTip>
                </div>
                {account.address && account.address !== '—' && (
                  <p className="text-sm text-muted-foreground">
                    <RevealValue
                      value={account.address}
                      masked={account.addressMasked}
                      copy
                    />
                  </p>
                )}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {['failed', 'stopped'].includes(account.status) ? (
                <Button
                  disabled={pending || !configured}
                  onClick={() =>
                    void mutate('POST', { action: 'restart', id: account.id })
                  }
                >
                  {uk.whatsapp.restart}
                </Button>
              ) : (
                <CrudButton
                  action="edit"
                  disabled={pending}
                  onClick={() => {
                    setLimit(String(account.dailyLimit));
                    setError('');
                    setEditing(true);
                  }}
                >
                  {uk.crud.editLimit}
                </CrudButton>
              )}
              <RowActions
                disabled={pending}
                actions={[
                  ...healthJournalAction(
                    health.find((item) => item.accountId === account.id),
                    setHealthJournal,
                  ),
                  {
                    kind: 'sync',
                    label: uk.whatsapp.repairWebhook,
                    onSelect: () =>
                      void mutate('POST', {
                        action: 'repair-webhook',
                        id: account.id,
                      }),
                  },
                  ...(account.status === 'active' || healthPaused
                    ? [
                        {
                          kind:
                            account.desiredEnabled && !healthPaused
                              ? ('disable' as const)
                              : ('enable' as const),
                          label:
                            account.desiredEnabled && !healthPaused
                              ? uk.email.disable
                              : uk.email.enable,
                          onSelect: () =>
                            void mutate('PATCH', {
                              id: account.id,
                              enabled: healthPaused || !account.desiredEnabled,
                            }),
                        },
                      ]
                    : []),
                  ...(account.status !== 'stopped'
                    ? [
                        {
                          kind: 'disconnect' as const,
                          label: uk.whatsapp.disconnect,
                          danger: true,
                          onSelect: () =>
                            void mutate('DELETE', { id: account.id }),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>
          <DetailList
            items={[
              { label: uk.email.owner, value: account.ownerName ?? '—' },
              {
                label: uk.email.today,
                value: `${account.sentToday} / ${account.dailyLimit}`,
              },
              {
                label: uk.email.next,
                value: account.nextSendAt
                  ? new Date(account.nextSendAt).toLocaleString('uk-UA')
                  : '—',
                hidden: !account.nextSendAt,
              },
            ]}
          />
          {account.reasonUk && (
            <p className="text-sm text-err">
              <FriendlyError reason={account.reasonUk} />
            </p>
          )}
          <HealthDetails
            health={health.find((item) => item.accountId === account.id)}
          />
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
          <CrudDialog
            open={editing}
            onOpenChange={setEditing}
            title={uk.crud.editLimit}
            pending={pending}
            draft={limit}
            actions={
              <Button
                type="submit"
                form={`whatsapp-limit-form-${account.id}`}
                disabled={pending}
              >
                {uk.forms.save}
              </Button>
            }
          >
            <form
              id={`whatsapp-limit-form-${account.id}`}
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate('PATCH', {
                  id: account.id,
                  dailyLimit: Number(limit),
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
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                />
              </div>
              {error && (
                <p role="alert" className="text-err">
                  {error}
                </p>
              )}
            </form>
          </CrudDialog>
        </article>
      ) : (
        <>
          <p>{uk.whatsapp.empty}</p>
          <CrudButton
            disabled={pending}
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            {uk.whatsapp.connect}
          </CrudButton>
          <CrudDialog
            open={open}
            onOpenChange={setOpen}
            title={uk.whatsapp.connect}
            pending={pending}
            draft={{ name, limit }}
            actions={
              <Button
                type="submit"
                form="whatsapp-account-connect"
                className="sm:col-span-2"
                disabled={pending || !configured}
              >
                {pending ? uk.ai.pending : uk.whatsapp.connect}
              </Button>
            }
          >
            <form
              id="whatsapp-account-connect"
              className="grid gap-4 sm:grid-cols-2"
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
              {error && (
                <p role="alert" className="text-err sm:col-span-2">
                  {error}
                </p>
              )}
            </form>
          </CrudDialog>
        </>
      )}
      {!open && !editing && error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </Card>
  );
}
