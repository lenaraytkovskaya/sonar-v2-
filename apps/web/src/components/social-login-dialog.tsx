'use client';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { listSocialAccounts } from '@sonar/db/social-accounts';
import { uk } from '@/i18n/uk';
import { CrudDialog } from './crud-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { LocalTime } from './local-time';

type Account = Awaited<ReturnType<typeof listSocialAccounts>>[number];
export function SocialLoginDialog({
  account,
  pending,
  notice,
  mutate,
  onClose,
}: {
  account: Account;
  pending: boolean;
  notice: string;
  mutate: (method: string, fields: object) => Promise<boolean>;
  onClose: () => void;
}) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [clearTotp, setClearTotp] = useState(false);
  const [code, setCode] = useState('');
  const [visible, setVisible] = useState(false);
  const challenge = ['email', 'sms'].includes(account.loginChallengeKind ?? '');
  const expired =
    !!account.loginChallengeExpiresAt &&
    new Date(account.loginChallengeExpiresAt).getTime() <= Date.now();
  const clear = () => {
    setLogin('');
    setPassword('');
    setTotpSecret('');
    setCode('');
    setVisible(false);
  };
  const submit = async (fields: object) => {
    if (await mutate('POST', { ...fields, id: account.id })) {
      clear();
      onClose();
    }
  };
  return (
    <CrudDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          clear();
          onClose();
        }
      }}
      title={`${uk.socialAccounts.credentialLogin} · ${account.name}`}
      pending={pending}
      draft={{
        login: !!login,
        password: !!password,
        totpSecret: !!totpSecret,
        code: !!code,
        clearTotp,
      }}
    >
      <p className="text-sm text-muted-foreground">
        {uk.socialAccounts.credentialsPrivacy}
      </p>
      {account.loginBlocked && (
        <p className="text-sm text-err">{uk.socialAccounts.loginBlocked}</p>
      )}
      {account.loginChallengeKind === 'captcha' && (
        <p role="status" className="text-sm text-wait">
          {uk.socialAccounts.captchaHelp}
        </p>
      )}
      {challenge && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ action: 'loginCode', code });
          }}
        >
          <label htmlFor="social-login-code">
            {account.loginChallengeKind === 'email'
              ? uk.socialAccounts.emailCode
              : uk.socialAccounts.smsCode}
          </label>
          <Input
            id="social-login-code"
            className="min-h-11"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            pattern="[0-9]{4,10}"
            maxLength={10}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={expired}
          />
          {account.loginChallengeExpiresAt && (
            <p className="text-sm">
              {uk.socialAccounts.codeExpires}:{' '}
              <LocalTime value={account.loginChallengeExpiresAt} />
            </p>
          )}
          {expired && (
            <p className="text-sm text-wait">{uk.socialAccounts.codeExpired}</p>
          )}
          <Button className="min-h-11" disabled={pending || expired}>
            {uk.socialAccounts.submitCode}
          </Button>
        </form>
      )}
      {!challenge && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit({
              action: 'credentials',
              login,
              password,
              ...(clearTotp
                ? { totpSecret: null }
                : totpSecret
                  ? { totpSecret }
                  : {}),
            });
          }}
        >
          {account.hasCredentials && (
            <p className="text-sm">{uk.socialAccounts.credentialsSaved}</p>
          )}
          <label htmlFor="social-login-name">{uk.socialAccounts.login}</label>
          <Input
            id="social-login-name"
            className="min-h-11"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={320}
            value={login}
            onChange={(event) => setLogin(event.target.value)}
          />
          <label htmlFor="social-login-password">
            {uk.socialAccounts.password}
          </label>
          <Input
            id="social-login-password"
            className="min-h-11"
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            required
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label htmlFor="social-login-totp">
            {uk.socialAccounts.totpSecret}
          </label>
          <Input
            id="social-login-totp"
            className="min-h-11"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            pattern="[A-Za-z2-7]{16,256}"
            maxLength={256}
            disabled={clearTotp}
            value={totpSecret}
            onChange={(event) =>
              setTotpSecret(
                event.target.value
                  .replace(/[\s-]/g, '')
                  .toUpperCase()
                  .replace(/=+$/, ''),
              )
            }
          />
          <p className="text-sm text-muted-foreground">
            {uk.socialAccounts.totpHelp}
          </p>
          {account.hasTotpSecret && (
            <>
              <p className="text-sm text-muted-foreground">
                {uk.socialAccounts.totpSaved}. {uk.socialAccounts.replaceTotp}
              </p>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={clearTotp}
                  onChange={(event) => {
                    setClearTotp(event.target.checked);
                    setTotpSecret('');
                  }}
                />
                {uk.socialAccounts.clearTotp}
              </label>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              type="button"
              variant="outline"
              disabled={!password && !totpSecret}
              onClick={() => setVisible(!visible)}
            >
              {visible ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
              {visible
                ? uk.socialAccounts.hideSecrets
                : uk.socialAccounts.showSecrets}
            </Button>
            <Button className="min-h-11" disabled={pending}>
              {uk.socialAccounts.saveAndLogin}
            </Button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </CrudDialog>
  );
}
