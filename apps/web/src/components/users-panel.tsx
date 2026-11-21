'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { uk } from '@/i18n/uk';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Member = { id: string; email: string; name: string; createdAt: string };
type Invite = {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
};
const date = (value: string) =>
  new Date(value).toLocaleString('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

export function UsersPanel() {
  const [users, setUsers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const load = useCallback(async () => {
    const response = await fetch('/api/users', { cache: 'no-store' });
    if (!response.ok) return;
    const data = (await response.json()) as {
      users: Member[];
      invites: Invite[];
    };
    setUsers(data.users);
    setInvites(data.invites);
  }, []);
  useEffect(() => {
    void load();
    // Mail goes out through the queue: refresh to show when it has been sent.
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [load]);
  async function invite(address: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setMessage(
        response.ok
          ? { ok: true, text: uk.users.invited }
          : { ok: false, text: data.error ?? uk.users.failed },
      );
      if (response.ok) setEmail('');
      await load();
    } catch {
      setMessage({ ok: false, text: uk.users.failed });
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    await fetch('/api/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    await load();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void invite(email);
  }
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="font-heading text-lg font-bold">
          {uk.users.inviteTitle}
        </h2>
        <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label
              htmlFor="invite-email"
              className="mb-2 block text-sm font-medium"
            >
              {uk.users.email}
            </label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? uk.users.inviting : uk.users.invite}
          </Button>
        </form>
        {message && (
          <p
            role="status"
            className={`mt-3 rounded-lg p-3 text-sm ${message.ok ? 'bg-chip text-accent' : 'bg-err-bg text-err'}`}
          >
            {message.text}
          </p>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="font-heading text-lg font-bold">{uk.users.pending}</h2>
        {invites.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{uk.users.empty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {invites.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{item.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.sentAt
                      ? `${uk.users.sent} ${date(item.sentAt)}`
                      : uk.users.notSent}
                    {' · '}
                    {uk.users.expires} {date(item.expiresAt)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void invite(item.email)}
                  >
                    {uk.users.resend}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void revoke(item.id)}
                  >
                    {uk.users.revoke}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="font-heading text-lg font-bold">{uk.users.members}</h2>
        <ul className="mt-3 divide-y divide-border">
          {users.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{item.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.email}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">
                {uk.users.since} {date(item.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
