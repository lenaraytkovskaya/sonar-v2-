'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { listSocialAccounts } from '@sonar/db/social-accounts';
import { uk } from '@/i18n/uk';
import { StatusBadge } from './shared';
import { ChannelIcon } from './channel-icon';
import { Callout, DetailList, InfoTip, Section } from './ui/layout';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { LocalTime } from './local-time';
import { SocialLoginDialog } from './social-login-dialog';
import { FriendlyError } from './friendly-error';
import { CrudButton, CrudDialog } from './crud-dialog';
import { RowActions } from './ui/row-actions';
import {
  HealthBadge,
  HealthDetails,
  HealthJournal,
  healthJournalAction,
  type AccountHealth,
} from './account-health';

type Account = Awaited<ReturnType<typeof listSocialAccounts>>[number];
function ownerDeviceDescription(account: Account) {
  const device = account.device;
  if (account.deviceSource !== 'owner_browser' || !device) return;
  const chrome = device.userAgent.match(/Chrome\/(\d+)/);
  const platform = device.extraHTTPHeaders?.['sec-ch-ua-platform']?.replace(
    /^"|"$/g,
    '',
  );
  const operatingSystem =
    platform ||
    (/Windows/.test(device.userAgent)
      ? 'Windows'
      : /Android/.test(device.userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(device.userAgent)
          ? 'iOS'
          : /Macintosh/.test(device.userAgent)
            ? 'macOS'
            : /Linux/.test(device.userAgent)
              ? 'Linux'
              : undefined);
  const dimensions = device.screen ?? device.viewport;
  return [
    chrome ? `Chrome ${chrome[1]}` : undefined,
    operatingSystem,
    `${dimensions.width}×${dimensions.height}`,
  ]
    .filter(Boolean)
    .join(', ');
}
function ownerBrowserParameters() {
  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: {
        brands: { brand: string; version: string }[];
        platform: string;
        mobile: boolean;
      };
    }
  ).userAgentData;
  return {
    userAgent: navigator.userAgent,
    ...(userAgentData
      ? {
          userAgentData: {
            brands: userAgentData.brands.map(({ brand, version }) => ({
              brand,
              version,
            })),
            platform: userAgentData.platform,
            mobile: userAgentData.mobile,
          },
        }
      : {}),
    screen: { width: window.screen.width, height: window.screen.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    languages: [...navigator.languages],
  };
}
/** "Проксі 7 · sol.ua-proxy.net": the number stays, the host makes it recognisable. */
function proxyName(index: number, labels: string[]) {
  const host = labels[index];
  return `${uk.socialAccounts.proxy} ${index + 1}${host ? ` · ${host}` : ''}`;
}
const selectClass =
  'min-h-11 w-full rounded-lg border border-border bg-surface px-3';
export function SocialAccounts({
  accounts,
  health = [],
  network,
  active,
  proxyCount,
  proxyLabels = [],
  accountProxyIndexes,
}: {
  accounts: Account[];
  health?: AccountHealth[];
  network: Account['network'];
  active: boolean;
  proxyCount: number;
  proxyLabels?: string[];
  accountProxyIndexes: Record<Account['network'], number | null>;
}) {
  const router = useRouter();
  const accountProxyIndex = accountProxyIndexes[network];
  const [healthJournal, setHealthJournal] = useState<AccountHealth | null>(
    null,
  );
  const [ownProxy, setOwnProxy] = useState('');
  const [keepaliveEnabled, setKeepaliveEnabled] = useState(true);
  const [current, setCurrent] = useState(accounts);
  const [open, setOpen] = useState(false);
  const [loginAccountId, setLoginAccountId] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [dailyLimit, setDailyLimit] = useState('20');
  const [proxyIndex, setProxyIndex] = useState(
    String(accountProxyIndex ?? 'own'),
  );
  const [cookiesJson, setCookiesJson] = useState('');
  const [addMode, setAddMode] = useState<'credentials' | 'cookies'>(
    'credentials',
  );
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
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
      router.refresh();
      setNotice(
        method === 'DELETE'
          ? uk.socialAccounts.removed
          : method === 'POST' &&
              'action' in fields &&
              [
                'credentials',
                'login',
                'loginCode',
                'createWithCredentials',
              ].includes(String(fields.action))
            ? fields.action === 'credentials' && response.status === 200
              ? uk.socialAccounts.credentialsSavedOnly
              : uk.socialAccounts.loginQueued
            : method === 'POST' &&
                'action' in fields &&
                fields.action === 'syncInbox'
              ? result.inboxSync?.created
                ? uk.socialAccounts.syncInboxQueued
                : uk.socialAccounts.syncInboxExisting
              : method === 'POST' &&
                  'action' in fields &&
                  ['inboxPolling', 'updateDevice'].includes(
                    String(fields.action),
                  )
                ? uk.outreach.saved
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
    setLogin('');
    setPassword('');
    setTotpSecret('');
    setAddMode('credentials');
    setOwnProxy('');
    setKeepaliveEnabled(true);
    setVisible(false);
    setDailyLimit('20');
    setProxyIndex(String(accountProxyIndex ?? 'own'));
  };
  const networkAccounts = current.filter(
    (account) => account.network === network,
  );
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          {uk.socialAccounts.title} · {uk.social.networks[network]}
          <InfoTip label={uk.socialAccounts.cookieHelp}>
            <ol className="list-decimal space-y-2 pl-5">
              {uk.socialAccounts.cookieSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-2">{uk.socialAccounts.cookiePrivacy}</p>
          </InfoTip>
        </span>
      }
      actions={
        <CrudButton
          disabled={pending}
          onClick={() => {
            reset();
            setNotice('');
            setOpen(true);
          }}
        >
          {uk.socialAccounts.add}
        </CrudButton>
      }
    >
      <div className="space-y-4">
        {!networkAccounts.length && (
          <p className="text-sm text-muted-foreground">
            {uk.socialAccounts.empty}
          </p>
        )}
        {networkAccounts.map((account) => {
          const needsLogin = account.sessionStatus === 'invalid';
          const deviceDescription = ownerDeviceDescription(account);
          const statusKey = needsLogin
            ? 'needs_login'
            : account.enabled
              ? account.status
              : 'disabled';
          return (
            <article
              key={account.id}
              className="space-y-4 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chip">
                    <ChannelIcon channel={account.network} />
                  </span>
                  <div className="min-w-0 max-w-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{account.name}</h3>
                      <HealthBadge
                        health={health.find(
                          (item) => item.accountId === account.id,
                        )}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {uk.email.owner}: {account.ownerName}
                    </p>
                  </div>
                  <span role="status">
                    <StatusBadge status={statusKey}>
                      {needsLogin
                        ? uk.socialAccounts.needsLogin
                        : (uk.socialAccounts.statuses[
                            account.status as keyof typeof uk.socialAccounts.statuses
                          ] ?? uk.tasks.status.paused)}
                    </StatusBadge>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {account.hasCredentials ? (
                    <Button
                      type="button"
                      variant={needsLogin ? 'default' : 'outline'}
                      disabled={
                        pending ||
                        account.loginBlocked ||
                        ['email', 'sms'].includes(
                          account.loginChallengeKind ?? '',
                        )
                      }
                      onClick={() =>
                        void mutate('POST', { action: 'login', id: account.id })
                      }
                    >
                      {uk.socialAccounts.retryLogin}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant={needsLogin ? 'default' : 'outline'}
                      disabled={pending}
                      onClick={() => {
                        setNotice('');
                        setLoginAccountId(account.id);
                      }}
                    >
                      {uk.socialAccounts.credentialLogin}
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
                  <RowActions
                    disabled={pending}
                    actions={[
                      ...healthJournalAction(
                        health.find((item) => item.accountId === account.id),
                        setHealthJournal,
                      ),
                      ...(account.hasCredentials
                        ? [
                            {
                              kind: 'login' as const,
                              label: uk.socialAccounts.credentialLogin,
                              onSelect: () => {
                                setNotice('');
                                setLoginAccountId(account.id);
                              },
                            },
                          ]
                        : []),
                      ...(['instagram', 'facebook'].includes(account.network)
                        ? [
                            {
                              kind: 'sync' as const,
                              label: uk.socialAccounts.syncInbox,
                              disabled: !account.canSyncInbox,
                              onSelect: () =>
                                void mutate('POST', {
                                  action: 'syncInbox',
                                  id: account.id,
                                }),
                            },
                          ]
                        : []),
                      ...(['instagram', 'facebook'].includes(account.network)
                        ? [
                            {
                              kind: 'poll' as const,
                              label: account.inboxPollingEnabled
                                ? uk.socialAccounts.pollDisable
                                : uk.socialAccounts.pollEnable,
                              disabled:
                                !account.inboxPollingEnabled &&
                                !account.canSyncInbox,
                              onSelect: () =>
                                void mutate('POST', {
                                  action: 'inboxPolling',
                                  id: account.id,
                                  enabled: !account.inboxPollingEnabled,
                                }),
                            },
                          ]
                        : []),
                      {
                        kind: 'score',
                        label: uk.socialAccounts.updateDevice,
                        onSelect: () =>
                          void mutate('POST', {
                            action: 'updateDevice',
                            id: account.id,
                            ownerBrowser: ownerBrowserParameters(),
                          }),
                      },
                      {
                        kind: 'edit',
                        label: uk.socialAccounts.edit,
                        separator: true,
                        onSelect: () => {
                          setNotice('');
                          setOpen(true);
                          setEditing(account.id);
                          setName(account.name);
                          setDailyLimit(String(account.dailyLimit));
                          setProxyIndex(
                            account.hasOwnProxy
                              ? 'own'
                              : String(account.proxyIndex),
                          );
                          setOwnProxy('');
                          setKeepaliveEnabled(account.keepaliveEnabled);
                          setCookiesJson('');
                          setAddMode('cookies');
                          setVisible(false);
                        },
                      },
                      {
                        kind: account.enabled ? 'disable' : 'enable',
                        label: account.enabled
                          ? uk.email.disable
                          : uk.email.enable,
                        disabled:
                          !account.enabled &&
                          account.sessionStatus !== 'valid' &&
                          !health.find((item) => item.accountId === account.id)
                            ?.pauseUntil,
                        onSelect: () =>
                          void mutate('PATCH', {
                            id: account.id,
                            enabled: !account.enabled,
                          }),
                      },
                      {
                        kind: 'delete',
                        label: uk.email.remove,
                        danger: true,
                        confirm: uk.socialAccounts.removeConfirm(account.name),
                        onSelect: () =>
                          void mutate('DELETE', {
                            action: 'remove',
                            id: account.id,
                          }),
                      },
                    ]}
                  />
                </div>
              </div>
              <HealthDetails
                health={health.find((item) => item.accountId === account.id)}
              />
              <DetailList
                items={[
                  {
                    label: uk.email.today,
                    value: `${account.sentToday} / ${account.dailyLimit}`,
                  },
                  {
                    label: uk.socialAccounts.proxy,
                    value: account.hasOwnProxy
                      ? uk.socialAccounts.ownProxy
                      : proxyName(account.proxyIndex, proxyLabels),
                  },
                  {
                    label: uk.social.checked,
                    value: account.checkedAt ? (
                      <LocalTime value={account.checkedAt} />
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: uk.email.next,
                    value: account.nextSendAt ? (
                      <LocalTime value={account.nextSendAt} />
                    ) : (
                      '—'
                    ),
                    hidden: !account.nextSendAt,
                  },
                  {
                    label: uk.socialAccounts.inboxLastCheck,
                    value: account.inboxSyncCheckedAt ? (
                      <span>
                        <LocalTime value={account.inboxSyncCheckedAt} />
                        {account.inboxSyncCreated !== null &&
                          ` · ${uk.socialAccounts.syncImported} ${account.inboxSyncCreated}`}
                      </span>
                    ) : (
                      '—'
                    ),
                    hidden: !['instagram', 'facebook'].includes(
                      account.network,
                    ),
                  },
                ]}
              />
              {deviceDescription && (
                <Callout tone="run">
                  <span className="text-xs">
                    {uk.socialAccounts.ownerBrowserDevice(deviceDescription)}
                  </span>
                </Callout>
              )}
              {account.loginBlocked && (
                <Callout tone="err">{uk.socialAccounts.loginBlocked}</Callout>
              )}
              {account.loginChallengeKind && (
                <Callout tone="wait">
                  {account.loginChallengeKind === 'captcha'
                    ? uk.socialAccounts.captchaHelp
                    : account.loginChallengeKind === 'email'
                      ? uk.socialAccounts.emailCode
                      : uk.socialAccounts.smsCode}
                </Callout>
              )}
              {account.reasonUk && (
                <Callout tone="err">
                  <FriendlyError reason={account.reasonUk} />
                  {account.failureShotKinds.some((kind) => kind !== 'inbox') && (
                    <a
                      className="ml-2 underline"
                      target="_blank"
                      rel="noreferrer"
                      href={`/api/social-accounts/failure-shot?id=${encodeURIComponent(account.id)}&kind=${account.failureShotKinds.find((kind) => kind !== 'inbox')}`}
                    >
                      {uk.socialAccounts.failureShot}
                    </a>
                  )}
                </Callout>
              )}
              {account.inboxSyncErrorUk && (
                <Callout tone="err">
                  {account.inboxSyncErrorUk}
                  {account.failureShotKinds.includes('inbox') && (
                    <a
                      className="ml-2 underline"
                      target="_blank"
                      rel="noreferrer"
                      href={`/api/social-accounts/failure-shot?id=${encodeURIComponent(account.id)}&kind=inbox`}
                    >
                      {uk.socialAccounts.failureShot}
                    </a>
                  )}
                </Callout>
              )}
              {account.inboxSyncComplete === false && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  {uk.socialAccounts.syncPartialShort}
                  <InfoTip>
                    <p>{uk.socialAccounts.syncPartial}</p>
                    <p className="mt-2">
                      {account.network === 'facebook'
                        ? uk.socialAccounts.syncFacebookInboxHint
                        : uk.socialAccounts.syncInboxHint}
                    </p>
                  </InfoTip>
                </p>
              )}
            </article>
          );
        })}
      </div>
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
        title={`${editing ? uk.socialAccounts.edit : uk.socialAccounts.add} · ${uk.social.networks[network]}`}
        pending={pending}
        draft={{
          name,
          dailyLimit,
          proxyIndex,
          cookiesJson,
          ownProxy,
          keepaliveEnabled,
          login,
          password,
          totpSecret,
          addMode,
        }}
        actions={
          <Button
            type="submit"
            form={`social-account-form-${network}`}
            disabled={pending || proxyIndex === ''}
          >
            {!editing && addMode === 'credentials'
              ? uk.socialAccounts.saveAndLogin
              : uk.forms.save}
          </Button>
        }
      >
        <form
          id={`social-account-form-${network}`}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const accountFields = {
              ...(editing ? { id: editing } : {}),
              name,
              network,
              dailyLimit: Number(dailyLimit),
              ...(proxyIndex === 'own'
                ? ownProxy.trim()
                  ? { ownProxy: ownProxy.trim() }
                  : {}
                : { proxyIndex: Number(proxyIndex), ownProxy: null }),
              keepaliveEnabled,
            };
            const fields =
              !editing && addMode === 'credentials'
                ? {
                    action: 'createWithCredentials',
                    ...accountFields,
                    login,
                    password,
                    ...(totpSecret.trim()
                      ? { totpSecret: totpSecret.trim() }
                      : {}),
                  }
                : {
                    ...accountFields,
                    ownerBrowser: ownerBrowserParameters(),
                    ...(cookiesJson.trim()
                      ? { storageStateJson: cookiesJson }
                      : {}),
                  };
            void mutate('POST', fields).then((saved) => {
              if (saved) {
                reset();
                setOpen(false);
              }
            });
          }}
        >
          {!editing && (
            <div
              role="tablist"
              aria-label={uk.socialAccounts.addMethod}
              className="flex gap-2 border-b border-border pb-2"
            >
              {(['credentials', 'cookies'] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={addMode === mode}
                  tabIndex={addMode === mode ? 0 : -1}
                  variant={addMode === mode ? 'default' : 'outline'}
                  onClick={() => setAddMode(mode)}
                >
                  {mode === 'credentials'
                    ? uk.socialAccounts.loginAndPassword
                    : uk.socialAccounts.cookiesTab}
                </Button>
              ))}
            </div>
          )}
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
              <label htmlFor={`social-${network}-limit`}>
                {uk.email.limit}
              </label>
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
                  <option key={index} value={index}>
                    {proxyName(index, proxyLabels)}
                    {' — '}
                    {Array.from(
                      new Set(
                        current
                          .filter(
                            (account) =>
                              !account.hasOwnProxy &&
                              account.proxyIndex === index,
                          )
                          .map(
                            (account) => uk.social.networks[account.network],
                          ),
                      ),
                    ).join(', ') || uk.socialAccounts.anonymousProxy}
                  </option>
                ))}
                <option value="own">{uk.socialAccounts.ownProxy}</option>
              </select>
              <p className="text-sm text-muted">
                {uk.socialAccounts.proxyHelp}
              </p>
              {proxyIndex === 'own' && (
                <>
                  <label htmlFor={`social-${network}-own-proxy`}>
                    {uk.socialAccounts.ownProxyUrl}
                  </label>
                  <Input
                    id={`social-${network}-own-proxy`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={4000}
                    value={ownProxy}
                    required={
                      !editing ||
                      !current.find((account) => account.id === editing)
                        ?.hasOwnProxy
                    }
                    onChange={(event) => setOwnProxy(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {uk.socialAccounts.ownProxyPrivacy}
                  </p>
                </>
              )}
              <p className="text-sm text-wait">
                {uk.socialAccounts.proxyChangeWarning}
              </p>
              {accountProxyIndex === null && (
                <p className="text-sm text-wait">{uk.socialAccounts.noProxy}</p>
              )}
            </div>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepaliveEnabled}
              onChange={(event) => setKeepaliveEnabled(event.target.checked)}
            />
            {uk.socialAccounts.keepalive}
          </label>
          {!editing && addMode === 'credentials' && (
            <div className="space-y-3">
              <div>
                <label htmlFor={`social-${network}-login`}>
                  {uk.socialAccounts.login}
                </label>
                <Input
                  id={`social-${network}-login`}
                  type="text"
                  autoComplete="username"
                  maxLength={320}
                  value={login}
                  required
                  onChange={(event) => setLogin(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`social-${network}-password`}>
                  {uk.socialAccounts.password}
                </label>
                <Input
                  id={`social-${network}-password`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={1024}
                  value={password}
                  required
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`social-${network}-totp`}>
                  {uk.socialAccounts.totpSecret}
                </label>
                <Input
                  id={`social-${network}-totp`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={256}
                  value={totpSecret}
                  onChange={(event) => setTotpSecret(event.target.value)}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {uk.socialAccounts.credentialsPrivacy}
              </p>
            </div>
          )}
          {(editing || addMode === 'cookies') && (
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
                autoComplete="off"
                spellCheck={false}
                value={cookiesJson}
                onChange={(event) => setCookiesJson(event.target.value)}
              />
              <p
                id={`social-${network}-cookies-help`}
                className="text-xs text-muted-foreground"
              >
                {uk.socialAccounts.passwordSetup}{' '}
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
          )}

          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
        </form>
      </CrudDialog>
      {current
        .filter((account) => account.id === loginAccountId)
        .map((account) => (
          <SocialLoginDialog
            key={account.id}
            account={account}
            pending={pending}
            notice={notice}
            mutate={mutate}
            onClose={() => setLoginAccountId(undefined)}
          />
        ))}
      {!open && !loginAccountId && notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </Section>
  );
}
