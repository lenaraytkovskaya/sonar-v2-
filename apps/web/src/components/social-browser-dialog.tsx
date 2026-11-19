'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { mapBrowserPoint } from '@/lib/social-browser-input';
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
  const [ready, setReady] = useState(false);
  const base = `/api/social-accounts/${accountId}/browser`;
  const openRequest = useRef<Promise<void> | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMoveAt = useRef(0);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const act = useCallback(
    async (body: object) => {
      try {
        await send(body);
        setError('');
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : uk.socialAccounts.browserUnavailable,
        );
      }
    },
    [send],
  );
  useEffect(() => {
    let active = true;
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    openRequest.current ??= send({ action: 'open' });
    void openRequest.current
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
      if (moveTimer.current) clearTimeout(moveTimer.current);
      releaseTimer.current = setTimeout(() => {
        void (openRequest.current ?? Promise.resolve())
          .catch(() => {})
          .then(() =>
            fetch(base, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'close' }),
              keepalive: true,
            }),
          )
          .catch(() => {});
      }, 0);
    };
  }, [base, send]);

  const point = (clientX: number, clientY: number, element: HTMLDivElement) => {
    const rect = element.getBoundingClientRect();
    return mapBrowserPoint(clientX, clientY, rect);
  };
  const mouse = (type: string, x: number, y: number) =>
    void act({ action: 'mouse', type, x, y });
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const next = point(event.clientX, event.clientY, event.currentTarget);
    pendingMove.current = next;
    const now = performance.now();
    const remaining = 32 - (now - lastMoveAt.current);
    if (remaining <= 0) {
      lastMoveAt.current = now;
      mouse('move', next.x, next.y);
    } else if (!moveTimer.current) {
      moveTimer.current = setTimeout(() => {
        moveTimer.current = null;
        const latest = pendingMove.current;
        if (latest) {
          lastMoveAt.current = performance.now();
          mouse('move', latest.x, latest.y);
        }
      }, remaining);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a') {
      event.preventDefault();
      void act({ action: 'key', selectAll: true });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'v') {
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => act({ action: 'text', text: text.slice(0, 4096) }))
        .catch(() => setError(uk.socialAccounts.browserClipboardUnavailable));
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (Array.from(key).length === 1 && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void act({ action: 'text', text: key });
      return;
    }
    const keys = [
      'Enter',
      'Tab',
      'Backspace',
      'Delete',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
    ];
    if (keys.includes(key)) {
      event.preventDefault();
      void act({ action: 'key', key });
    }
  };
  const close = async (done: boolean) => {
    try {
      await send({ action: 'close' });
      if (done) onDone();
      else onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : uk.socialAccounts.browserUnavailable,
      );
    }
  };

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
          <Button
            type="button"
            variant="outline"
            onClick={() => void close(false)}
          >
            {uk.crud.close}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {uk.socialAccounts.browserHelp}
        </p>
        <div
          className="aspect-[8/5] w-full touch-none overflow-hidden rounded-lg border border-border bg-black"
          onPointerMove={onPointerMove}
          onPointerDown={(event) => {
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const { x, y } = point(
              event.clientX,
              event.clientY,
              event.currentTarget,
            );
            mouse('down', x, y);
          }}
          onPointerUp={(event) => {
            const { x, y } = point(
              event.clientX,
              event.clientY,
              event.currentTarget,
            );
            mouse('up', x, y);
          }}
          onWheel={(event) => {
            event.preventDefault();
            const { x, y } = point(
              event.clientX,
              event.clientY,
              event.currentTarget,
            );
            void act({
              action: 'wheel',
              x,
              y,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
          }}
          onKeyDown={onKeyDown}
          tabIndex={0}
          aria-label={uk.socialAccounts.browserTitle}
        >
          {ready ? (
            <img
              className="block size-full select-none object-fill"
              src={base}
              alt={uk.socialAccounts.browserTitle}
              draggable={false}
              onError={() => setError(uk.socialAccounts.browserUnavailable)}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-white">
              {error || uk.socialAccounts.browserStarting}
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!ready}
            onClick={() => void close(true)}
          >
            {uk.socialAccounts.browserDone}
          </Button>
        </div>
      </section>
    </div>
  );
}
