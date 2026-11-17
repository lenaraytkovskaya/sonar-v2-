'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import type { listViberAccounts } from '@sonar/db/viber';
import { uk } from '@/i18n/uk';
import { Card, StatusBadge } from './shared';
import { ChannelIcon } from './channel-icon';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FriendlyError } from './friendly-error';
import {
  HealthBadge,
  HealthDetails,
  type AccountHealth,
} from './account-health';

type Account = Awaited<ReturnType<typeof listViberAccounts>>[number];
type Bridge = {
  state: 'not_running' | 'needs_activation' | 'ready' | 'error';
  number?: string;
  version?: string;
  reason?: string;
};

export function ViberAccounts({
  accounts,
  health = [],
}: {
  accounts: Account[];
  health?: AccountHealth[];
}) {
  const account = accounts[0];
  const [bridge, setBridge] = useState<Bridge>({ state: 'error' });
  const [screen, setScreen] = useState(false);
  const [showFailure, setShowFailure] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [limit, setLimit] = useState(String(account?.dailyLimit ?? 20));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [accountStatus, setAccountStatus] = useState(
    account?.status ?? 'paused',
  );
  const accountHealth = health.find((item) => item.accountId === account?.id);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/viber', { cache: 'no-store' });
        const data = await response.json();
        if (active && response.ok) setBridge(data.bridge);
      } catch {
        if (active) setBridge({ state: 'error' });
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
      setImageVersion((value) => value + 1);
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const update = async (values: object) => {
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/viber', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      if (data.accounts?.[0]) setLimit(String(data.accounts[0].dailyLimit));
      if (data.accounts?.[0]) setAccountStatus(data.accounts[0].status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uk.email.error);
    } finally {
      setPending(false);
    }
  };
  const stateText = {
    not_running: uk.viber.disconnected,
    needs_activation: uk.viber.activation,
    ready: uk.viber.ready,
    error: uk.viber.error,
  }[bridge.state];
  const tone =
    bridge.state === 'ready'
      ? 'ok'
      : bridge.state === 'needs_activation'
        ? 'wait'
        : bridge.state === 'error'
          ? 'err'
          : 'idle';
  return (
    <Card className="space-y-4 p-5">
      <h2 className="flex items-center gap-2 border-b border-border pb-4 font-heading text-base font-semibold">
        <ChannelIcon channel="viber" />
        {uk.viber.title}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={tone}>{stateText}</StatusBadge>
        {bridge.number && (
          <span className="text-sm text-muted-foreground">{bridge.number}</span>
        )}
        {bridge.version && (
          <span className="text-xs text-muted-foreground">
            Viber {bridge.version}
          </span>
        )}
      </div>
      {account && (
        <>
          <HealthBadge health={accountHealth} />
          <HealthDetails health={accountHealth} />
        </>
      )}
      {bridge.reason && <FriendlyError reason={bridge.reason} />}
      {account && (
        <p className="text-sm">
          {uk.viber.today}: {account.sentToday} / {account.dailyLimit}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          {uk.viber.limit}
          <Input
            type="number"
            min={1}
            max={500}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        <Button
          disabled={pending}
          onClick={() => void update({ dailyLimit: Number(limit) })}
        >
          {uk.forms.save}
        </Button>
        {account && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void update({ paused: accountStatus !== 'paused' })}
          >
            {accountStatus === 'paused' ? uk.viber.resume : uk.viber.pause}
          </Button>
        )}
        <Button variant="outline" onClick={() => setScreen((value) => !value)}>
          {uk.viber.connect}
        </Button>
        <Button
          variant="outline"
          onClick={() => setShowFailure((value) => !value)}
        >
          {uk.viber.lastFailure}
        </Button>
      </div>
      {screen && (
        <section className="space-y-2">
          <p className="text-sm">{uk.viber.scanHint}</p>
          <Image
            unoptimized
            width={1280}
            height={720}
            alt={uk.viber.screen}
            src={`/api/viber/screen?v=${imageVersion}`}
            className="h-auto max-h-[70vh] w-full rounded-lg border border-border object-contain"
          />
        </section>
      )}
      {showFailure && (
        <section className="space-y-2">
          <Image
            unoptimized
            width={1280}
            height={720}
            alt={uk.viber.lastFailure}
            src={`/api/viber/screen?lastFailure=1&v=${imageVersion}`}
            className="h-auto max-h-[70vh] w-full rounded-lg border border-border object-contain"
          />
        </section>
      )}
      {error && <FriendlyError reason={error} />}
    </Card>
  );
}
