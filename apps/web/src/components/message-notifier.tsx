'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, X } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { channelLabel } from '@/lib/outreach-labels';
import { ChannelIcon } from './channel-icon';

type Latest = {
  id: string;
  conversationId: string;
  channel: string;
  body: string;
  companyName: string | null;
};
export const SOUND_KEY = 'sonar.notify.sound';
const POLL_MS = 20000;

/** Messenger-style alert: short two-tone chime, no audio file needed. */
function chime() {
  try {
    const context = new AudioContext();
    [880, 1320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      const start = context.currentTime + index * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    });
    setTimeout(() => void context.close(), 1000);
  } catch {
    /* Audio may be blocked until the first user gesture. */
  }
}
const soundOn = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * Watches for new inbound messages anywhere in Sonar and shows a toast, plays a chime and,
 * when allowed, a browser notification. The first poll only sets the baseline.
 */
export function MessageNotifier() {
  const router = useRouter();
  const seen = useRef<string | null | undefined>(undefined);
  const [toast, setToast] = useState<Latest | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/conversations/unread', {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const { latest } = (await response.json()) as {
          latest: Latest | null;
        };
        if (stopped) return;
        const first = seen.current === undefined;
        const fresh = latest && latest.id !== seen.current;
        seen.current = latest?.id ?? null;
        if (first || !fresh || !latest) return;
        setToast(latest);
        if (soundOn()) chime();
        if (
          'Notification' in window &&
          Notification.permission === 'granted' &&
          document.visibilityState !== 'visible'
        ) {
          const notification = new Notification(uk.notifications.title, {
            body: `${latest.companyName ?? uk.inbound.unknownCompany} · ${channelLabel(latest.channel)}\n${latest.body}`,
            tag: latest.id,
          });
          notification.onclick = () => {
            window.focus();
            router.push(`/inbox?conversation=${latest.conversationId}`);
          };
        }
      } catch {
        /* Network blips just skip one poll. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 10000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-3 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <MessageCircle aria-hidden className="mt-0.5 size-5 text-accent" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            setToast(null);
            router.push(`/inbox?conversation=${toast.conversationId}`);
          }}
        >
          <p className="text-sm font-semibold">{uk.notifications.title}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChannelIcon channel={toast.channel} />
            {toast.companyName ?? uk.inbound.unknownCompany} ·{' '}
            {channelLabel(toast.channel)}
          </p>
          <p className="mt-1 line-clamp-2 text-sm">{toast.body}</p>
        </button>
        <button
          type="button"
          aria-label={uk.notifications.close}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setToast(null)}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Settings controls: chime on/off and browser notification permission. */
export function NotificationSettings({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const [sound, setSound] = useState(true);
  const [permission, setPermission] = useState<string>('default');
  useEffect(() => {
    setSound(soundOn());
    setPermission(
      'Notification' in window ? Notification.permission : 'unsupported',
    );
  }, []);
  return (
    <section
      className={
        embedded
          ? 'space-y-5'
          : 'space-y-3 rounded-xl border border-border bg-surface p-6 shadow-xs'
      }
    >
      {!embedded && (
        <h2 className="font-heading text-base font-bold">
          {uk.notifications.settings}
        </h2>
      )}
      <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
        <input
          className="order-last"
          type="checkbox"
          checked={sound}
          onChange={(event) => {
            setSound(event.target.checked);
            try {
              localStorage.setItem(
                SOUND_KEY,
                event.target.checked ? 'on' : 'off',
              );
            } catch {
              /* Private mode: keep the in-memory choice. */
            }
            if (event.target.checked) chime();
          }}
        />
        {uk.notifications.sound}
      </label>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-4 border-t border-border pt-5 text-sm">
        <span>{uk.notifications.browser}:</span>
        {permission === 'granted' ? (
          <span className="text-ok">{uk.notifications.allowed}</span>
        ) : permission === 'denied' ? (
          <span className="text-err">{uk.notifications.denied}</span>
        ) : permission === 'unsupported' ? (
          <span className="text-muted-foreground">
            {uk.notifications.unsupported}
          </span>
        ) : (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 hover:bg-raised"
            onClick={() =>
              void Notification.requestPermission().then(setPermission)
            }
          >
            {uk.notifications.allow}
          </button>
        )}
      </div>
    </section>
  );
}
