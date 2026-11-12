'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { Card } from './shared';
import { Button } from './ui/button';

export function SendTestMode({
  enabled,
  allowlist,
}: {
  enabled: boolean;
  allowlist: string[];
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled),
    [text, setText] = useState(allowlist.join('\n')),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState('');
  const save = async (nextOn: boolean) => {
    setPending(true);
    setMessage('');
    try {
      const response = await fetch('/api/send-test-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextOn,
          allowlist: text
            .split(/[\n,;]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? uk.email.error);
      setOn(nextOn);
      setMessage(uk.testMode.saved);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uk.email.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card className={'space-y-3 p-5 ' + (on ? 'border-wait bg-wait-bg' : '')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-base font-bold">
          {uk.testMode.title} · {on ? uk.testMode.on : uk.testMode.off}
        </h2>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void save(!on)}
        >
          {on ? uk.testMode.disable : uk.testMode.enable}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{uk.testMode.hint}</p>
      <label className="block">
        <span className="text-sm">{uk.testMode.list}</span>
        <textarea
          className="mt-2 min-h-24 w-full rounded-lg border border-border bg-surface p-3"
          value={text}
          maxLength={20000}
          placeholder={uk.testMode.placeholder}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <Button disabled={pending} onClick={() => void save(on)}>
        {uk.forms.save}
      </Button>
      {message && <p role="status">{message}</p>}
    </Card>
  );
}
