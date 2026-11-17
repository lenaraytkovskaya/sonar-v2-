'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { uk } from '@/i18n/uk';
import { claimSocialSessionEvent } from '@/lib/social-session-notices';
import { FriendlyError } from './friendly-error';

type Notice = {
  id: string;
  name: string;
  network: keyof typeof uk.social.networks;
  eventId: string;
  reasonUk: string | null;
};
export function SocialSessionNotices() {
  const path = usePathname();
  const seen = useRef(new Set<string>());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toast, setToast] = useState<Notice[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch('/api/social-accounts/notices', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data: { userId: string; notices: Notice[] } =
          await response.json();
        if (controller.signal.aborted) return;
        setNotices(data.notices);
        const fresh = data.notices.filter((notice) => {
          const key = `sonar.session-lost:${data.userId}:${notice.id}`;
          return claimSocialSessionEvent(key, notice.eventId, seen.current);
        });
        if (fresh.length) setToast((current) => [...current, ...fresh]);
      } catch {
        /* Retry on the next poll after a network interruption. */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 20000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      {path === '/' && notices.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-err bg-surface p-4 text-err"
        >
          <p className="font-semibold">{uk.socialAccounts.sessionLostBanner}</p>
          <p className="text-sm">
            {notices
              .map(
                (notice) =>
                  `${notice.name} · ${uk.social.networks[notice.network]}`,
              )
              .join(', ')}
          </p>
          <Link
            href="/channels"
            className="inline-flex min-h-11 items-center underline"
          >
            {uk.socialAccounts.openChannels}
          </Link>
        </div>
      )}
      {toast.length > 0 && (
        <aside
          role="status"
          aria-live="polite"
          className="fixed right-4 bottom-24 z-50 max-h-[60dvh] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-err bg-surface p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-err">
              {uk.socialAccounts.sessionLost}
            </p>
            <button
              type="button"
              aria-label={uk.notifications.close}
              className="min-h-11 min-w-11"
              onClick={() => setToast([])}
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
          {toast.map((notice) => (
            <p key={`${notice.id}:${notice.eventId}`} className="mt-2 text-sm">
              {uk.socialAccounts.sessionExpired.replace(
                '{network}',
                uk.social.networks[notice.network],
              )}{' '}
              ({notice.name}){notice.reasonUk ? <>: <FriendlyError reason={notice.reasonUk} /></> : ''}
            </p>
          ))}
          <Link
            href="/channels"
            className="inline-flex min-h-11 items-center text-accent underline"
            onClick={() => setToast([])}
          >
            {uk.socialAccounts.openChannels}
          </Link>
        </aside>
      )}
    </>
  );
}
