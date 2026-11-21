'use client';
import { useActionState } from 'react';
import { acceptInvite } from './actions';
import { uk } from '@/i18n/uk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function InviteForm({ token }: { token: string }) {
  const [error, action, pending] = useActionState(
    acceptInvite.bind(null, token),
    '',
  );
  return (
    <form action={action} className="mt-8 space-y-5">
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-medium">
          {uk.invite.name}
        </label>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          maxLength={200}
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-2 block text-sm font-medium">
          {uk.invite.password}
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          required
        />
      </div>
      <div>
        <label htmlFor="confirm" className="mb-2 block text-sm font-medium">
          {uk.invite.confirm}
        </label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
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
        {pending ? uk.invite.pending : uk.invite.submit}
      </Button>
    </form>
  );
}
