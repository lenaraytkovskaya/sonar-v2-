'use client';
import { useActionState, useState } from 'react';
import { login } from './actions';
import { uk } from '@/i18n/uk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function LoginForm({ returnTo }: { returnTo: string }) {
  const [email, setEmail] = useState('');
  const [error, action, pending] = useActionState(login, '');
  return (
    <form action={action} className="mt-8 space-y-5">
      <input type="hidden" name="next" value={returnTo} />
      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-medium">
          {uk.login.email}
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-2 block text-sm font-medium">
          {uk.login.password}
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          required
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-err-bg p-3 text-sm text-err">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? uk.login.pending : uk.login.submit}
      </Button>
    </form>
  );
}
