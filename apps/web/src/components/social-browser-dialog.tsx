'use client';

import { useCallback, useEffect, useState } from 'react';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';

export function SocialBrowserDialog({
  accountId,
  onClose,
  onDone,
}: {
  accountId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const base = `/api/social-accounts/${accountId}/browser`;
  const send = useCallback(
    async (body: object) => {
      const response = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error ??
            uk.socialAccounts.browserUnavailable,
        );
    },
    [base],
  );
  useEffect(() => {
    let active = true;
    void send({ action: 'open' })
      .then(() => {
        if (active) setReady(true);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : uk.socialAccounts.browserUnavailable,
          );
      });
    return () => {
      active = false;
    };
  }, [send]);
  const act = async (body: object) => {
    setError('');
    try {
      await send(body);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : uk.socialAccounts.browserUnavailable,
      );
    }
  };
  const refresh = useCallback(() => `${base}?t=${Date.now()}`, [base]);
  const [screenUrl, setScreenUrl] = useState('');
  useEffect(() => {
    if (!ready) return;
    const update = () => setScreenUrl(refresh());
    update();
    const timer = setInterval(update, 2500);
    return () => clearInterval(timer);
  }, [ready, refresh]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="social-browser-title"
        className="flex max-h-[96vh] w-full max-w-5xl flex-col gap-3 overflow-auto rounded-xl bg-surface p-4 text-foreground shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="social-browser-title" className="text-lg font-semibold">
            {uk.socialAccounts.browserTitle}
          </h2>
          <Button type="button" variant="outline" onClick={onClose}>
            {uk.crud.close}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {uk.socialAccounts.browserHelp}
        </p>
        <div className="min-h-64 overflow-hidden rounded-lg border border-border bg-black">
          {ready && screenUrl ? (
            <img
              className="block max-h-[62vh] w-full object-contain"
              src={screenUrl}
              alt={uk.socialAccounts.browserTitle}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const scale = Math.min(rect.width / 1280, rect.height / 800);
                const width = 1280 * scale;
                const height = 800 * scale;
                const left = rect.left + (rect.width - width) / 2;
                const top = rect.top + (rect.height - height) / 2;
                void act({
                  action: 'click',
                  x: ((event.clientX - left) / width) * 1280,
                  y: ((event.clientY - top) / height) * 800,
                });
              }}
            />
          ) : (
            <div className="p-8 text-center text-sm text-white">
              {ready
                ? uk.socialAccounts.browserLoading
                : uk.socialAccounts.browserStarting}
            </div>
          )}
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = text;
            setText('');
            if (value) void act({ action: 'text', text: value });
          }}
        >
          <input
            aria-label={uk.socialAccounts.browserTextLabel}
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-11 min-w-48 flex-1 rounded-lg border border-border bg-background px-3"
          />
          <Button type="submit">{uk.socialAccounts.browserType}</Button>
          {(['Tab', 'Enter', 'Backspace', 'Escape'] as const).map((key) => (
            <Button
              key={key}
              type="button"
              variant="outline"
              onClick={() => void act({ action: 'key', key })}
            >
              {key}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setScreenUrl(refresh());
            }}
          >
            {uk.socialAccounts.browserRefresh}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" disabled={!ready} onClick={onDone}>
            {uk.socialAccounts.browserDone}
          </Button>
        </div>
      </section>
    </div>
  );
}
