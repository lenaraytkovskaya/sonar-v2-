'use client';
import { useEffect, useRef, useState } from 'react';
import type { listSocialAccounts } from '@sonar/db/social-accounts';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AiAssist } from './ai-assist';
import { LocalTime } from './local-time';
import { SocialLoginDialog } from './social-login-dialog';
import { CrudButton, CrudDialog } from './crud-dialog';
import { RowActions } from './ui/row-actions';

type Account = Awaited<ReturnType<typeof listSocialAccounts>>[number];
/** "Проксі 7 · sol.ua-proxy.net": the number stays, the host makes it recognisable. */
function proxyName(index: number, labels: string[]) {
  const host = labels[index];
  return `${uk.socialAccounts.proxy} ${index + 1}${host ? ` · ${host}` : ''}`;
}
const selectClass =
  'min-h-11 w-full rounded-lg border border-border bg-surface px-3';
export function SocialAccounts({
  accounts,
  network,
  active,
  proxyCount,
  proxyLabels = [],
  accountProxyIndexes,
}: {
  accounts: Account[];
  network: Account['network'];
  active: boolean;
  proxyCount: number;
  proxyLabels?: string[];
  accountProxyIndexes: Record<Account['network'], number | null>;
}) {
  const accountProxyIndex = accountProxyIndexes[network];
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
                  fields.action === 'inboxPolling'
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
            {account.hasOwnProxy
              ? uk.socialAccounts.ownProxy
              : proxyName(account.proxyIndex, proxyLabels)}
          </p>
          <p role="status">
            {account.sessionStatus === 'invalid'
              ? uk.socialAccounts.needsLogin
              : (uk.socialAccounts.statuses[
                  account.status as keyof typeof uk.socialAccounts.statuses
                ] ?? uk.tasks.status.paused)}
          </p>
          {account.network === 'facebook' && (
            <Button
              type="button"
              variant="outline"
              disabled={
                pending ||
                (!account.inboxPollingEnabled && !account.canSyncInbox)
              }
              onClick={() =>
                void mutate('POST', {
                  action: 'inboxPolling',
                  id: account.id,
                  enabled: !account.inboxPollingEnabled,
                })
              }
            >
              {account.inboxPollingEnabled
                ? uk.socialAccounts.pollDisable
                : uk.socialAccounts.pollEnable}
            </Button>
          )}
          {account.inboxSyncCreated !== null && (
            <p>
              {uk.socialAccounts.syncImported} {account.inboxSyncCreated}
            </p>
          )}
          {account.inboxSyncComplete === false && (
            <p className="text-wait">{uk.socialAccounts.syncPartial}</p>
          )}
          {account.loginBlocked && (
            <p className="text-err">{uk.socialAccounts.loginBlocked}</p>
          )}
          {account.loginChallengeKind && (
            <p className="text-wait">
              {account.loginChallengeKind === 'captcha'
                ? uk.socialAccounts.captchaHelp
                : account.loginChallengeKind === 'email'
                  ? uk.socialAccounts.emailCode
                  : uk.socialAccounts.smsCode}
            </p>
          )}
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
            <Button
              type="button"
              className="min-h-11"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setNotice('');
                setLoginAccountId(account.id);
              }}
            >
              {uk.socialAccounts.credentialLogin}
            </Button>
            {account.hasCredentials && (
              <Button
                type="button"
                className="min-h-11"
                variant="outline"
                disabled={
                  pending ||
                  account.loginBlocked ||
                  ['email', 'sms'].includes(account.loginChallengeKind ?? '')
                }
                onClick={() =>
                  void mutate('POST', { action: 'login', id: account.id })
                }
              >
                {uk.socialAccounts.retryLogin}
              </Button>
            )}
            {['instagram', 'facebook'].includes(account.network) && (
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
            <RowActions
              disabled={pending}
              actions={[
                {
                  kind: 'edit',
                  label: uk.socialAccounts.edit,
                  onSelect: () => {
                    setNotice('');
                    setOpen(true);
                    setEditing(account.id);
                    setName(account.name);
                    setDailyLimit(String(account.dailyLimit));
                    setProxyIndex(
                      account.hasOwnProxy ? 'own' : String(account.proxyIndex),
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
                  label: account.enabled ? uk.email.disable : uk.email.enable,
                  disabled:
                    !account.enabled && account.sessionStatus !== 'valid',
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
                    void mutate('DELETE', { action: 'remove', id: account.id }),
                },
              ]}
            />
          </div>
          {['instagram', 'facebook'].includes(account.network) && (
            <p className="text-muted-foreground">
              {account.network === 'facebook'
                ? uk.socialAccounts.syncFacebookInboxHint
                : uk.socialAccounts.syncInboxHint}
            </p>
          )}
        </section>
      ))}
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
      >
        <form
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
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || proxyIndex === ''}>
              {!editing && addMode === 'credentials'
                ? uk.socialAccounts.saveAndLogin
                : uk.forms.save}
            </Button>
          </div>
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
    </Card>
  );
}
