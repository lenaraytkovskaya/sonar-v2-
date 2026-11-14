'use client';
import { useEffect, useRef, useState } from 'react';
import type { listSocialAccounts } from '@sonar/db/social-accounts';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { LocalTime } from './local-time';

type Account = Awaited<ReturnType<typeof listSocialAccounts>>[number];
const selectClass =
  'min-h-11 w-full rounded-lg border border-border bg-surface px-3';
export function SocialAccounts({
  accounts,
  network,
  active,
  proxyCount,
  accountProxyIndex,
}: {
  accounts: Account[];
  network: Account['network'];
  active: boolean;
  proxyCount: number;
  accountProxyIndex: number | null;
}) {
  const [current, setCurrent] = useState(accounts);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [dailyLimit, setDailyLimit] = useState('20');
  const [proxyIndex, setProxyIndex] = useState(String(accountProxyIndex ?? ''));
  const [cookiesJson, setCookiesJson] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  useEffect(() => setCurrent(accounts), [accounts]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (busy.current) return;
      void fetch('/api/social-accounts', {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.ok) setCurrent((await response.json()).accounts);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active]);
  const mutate = async (method: string, fields: object) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setNotice('');
    try {
      const response = await fetch('/api/social-accounts', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? uk.email.error);
      setCurrent(result.accounts);
      setNotice(
        method === 'POST' && 'action' in fields && fields.action === 'syncInbox'
          ? result.inboxSync?.created
            ? uk.socialAccounts.syncInboxQueued
            : uk.socialAccounts.syncInboxExisting
          : method === 'POST' && 'action' in fields
            ? uk.socialAccounts.checkQueued
            : uk.outreach.saved,
      );
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : uk.email.error);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const reset = () => {
    setEditing(undefined);
    setName('');
    setCookiesJson('');
    setVisible(false);
    setDailyLimit('20');
    setProxyIndex(String(accountProxyIndex ?? ''));
  };
  const networkAccounts = current.filter(
    (account) => account.network === network,
  );
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-heading text-base font-bold">
        {uk.socialAccounts.title} · {uk.social.networks[network]}
      </h2>
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer text-accent">
          {uk.socialAccounts.cookieHelp}
        </summary>
        <ol className="list-decimal space-y-2 pl-5">
          {uk.socialAccounts.cookieSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-2 text-muted-foreground">
          {uk.socialAccounts.cookiePrivacy}
        </p>
      </details>
      {networkAccounts.map((account) => (
        <section
          key={account.id}
          className="space-y-2 border-t border-border pt-3 text-sm"
        >
          <h3 className="font-semibold">
            {account.name} · {uk.social.networks[account.network]}
          </h3>
          <p>
            {uk.email.owner}: {account.ownerName}
          </p>
          <p>
            {uk.email.today}: {account.sentToday} / {account.dailyLimit} ·{' '}
            {uk.socialAccounts.proxy} {account.proxyIndex + 1}
          </p>
          <p role="status">
            {account.status === 'paused' && account.sessionStatus === 'invalid'
              ? uk.socialAccounts.needsLogin
              : (uk.socialAccounts.statuses[
                  account.status as keyof typeof uk.socialAccounts.statuses
                ] ?? uk.tasks.status.paused)}
          </p>
          {account.reasonUk && <p className="text-err">{account.reasonUk}</p>}
          {account.checkedAt && (
            <p>
              {uk.social.checked}: <LocalTime value={account.checkedAt} />
            </p>
          )}
          {account.nextSendAt && (
            <p>
              {uk.email.next}: <LocalTime value={account.nextSendAt} />
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {account.network === 'instagram' && (
              <Button
                type="button"
                variant="outline"
                disabled={pending || !account.canSyncInbox}
                onClick={() =>
                  void mutate('POST', { action: 'syncInbox', id: account.id })
                }
              >
                {uk.socialAccounts.syncInbox}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void mutate('POST', { action: 'check', id: account.id })
              }
            >
              {uk.socialAccounts.check}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setEditing(account.id);
                setName(account.name);
                setDailyLimit(String(account.dailyLimit));
                setProxyIndex(String(account.proxyIndex));
                setCookiesJson('');
                setVisible(false);
              }}
            >
              {uk.socialAccounts.edit}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                pending ||
                (!account.enabled && account.sessionStatus !== 'valid')
              }
              onClick={() =>
                void mutate('PATCH', {
                  id: account.id,
                  enabled: !account.enabled,
                })
              }
            >
              {account.enabled ? uk.email.disable : uk.email.enable}
            </Button>
          </div>
          {account.network === 'instagram' && (
            <p className="text-muted-foreground">
              {uk.socialAccounts.syncInboxHint}
            </p>
          )}
        </section>
      ))}
      <form
        className="space-y-3 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate('POST', {
            ...(editing ? { id: editing } : {}),
            name,
            network,
            dailyLimit: Number(dailyLimit),
            proxyIndex: Number(proxyIndex),
            ...(cookiesJson.trim() ? { cookiesJson } : {}),
          }).then((saved) => {
            if (saved) reset();
          });
        }}
      >
        <h3 className="font-semibold">
          {editing ? uk.socialAccounts.edit : uk.socialAccounts.add} ·{' '}
          {uk.social.networks[network]}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`social-${network}-name`}>
              {uk.email.name} · {uk.social.networks[network]}
            </label>
            <Input
              id={`social-${network}-name`}
              placeholder={uk.socialAccounts.namePlaceholders[network]}
              value={name}
              required
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
            <AiAssist text={name} onApply={setName} />
          </div>
          <div>
            <label htmlFor={`social-${network}-limit`}>{uk.email.limit}</label>
            <Input
              id={`social-${network}-limit`}
              type="number"
              min={1}
              step={1}
              required
              value={dailyLimit}
              onChange={(event) => setDailyLimit(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`social-${network}-proxy`}>
              {uk.socialAccounts.proxy}
            </label>
            <select
              id={`social-${network}-proxy`}
              className={selectClass}
              required
              value={proxyIndex}
              onChange={(event) => setProxyIndex(event.target.value)}
            >
              {Array.from({ length: proxyCount }, (_, index) => (
                <option
                  key={index}
                  value={index}
                  disabled={index !== accountProxyIndex}
                >
                  {uk.socialAccounts.proxy} {index + 1}
                  {index === accountProxyIndex
                    ? uk.socialAccounts.reservedProxy
                    : uk.socialAccounts.anonymousProxy}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted">{uk.socialAccounts.proxyHelp}</p>
            {accountProxyIndex === null && (
              <p className="text-sm text-wait">{uk.socialAccounts.noProxy}</p>
            )}
          </div>
        </div>
        <div>
          <label htmlFor={`social-${network}-cookies`}>
            {uk.socialAccounts.cookies} · {uk.social.networks[network]}
          </label>
          <textarea
            id={`social-${network}-cookies`}
            placeholder={uk.socialAccounts.cookiesPlaceholder}
            aria-describedby={`social-${network}-cookies-help`}
            className="w-full rounded-lg border border-border bg-surface p-3 font-mono text-sm"
            style={
              visible || !cookiesJson
                ? undefined
                : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)
            }
            rows={4}
            required={!editing}
            autoComplete="off"
            spellCheck={false}
            value={cookiesJson}
            onChange={(event) => setCookiesJson(event.target.value)}
          />
          <p
            id={`social-${network}-cookies-help`}
            className="text-xs text-muted-foreground"
          >
            {uk.socialAccounts.cookiesHint[network]}{' '}
            {editing
              ? uk.socialAccounts.replaceCookies
              : uk.socialAccounts.cookiePrivacy}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setVisible(!visible)}
          >
            {visible ? uk.socialAccounts.hide : uk.socialAccounts.show}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || accountProxyIndex === null}>
            {uk.forms.save}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={reset}
            >
              {uk.ai.cancel}
            </Button>
          )}
        </div>
      </form>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </Card>
  );
}
