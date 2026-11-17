import Link from 'next/link';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';
export function InboxModeTabs({ mode }: { mode: 'chats' | 'forms' }) {
  return (
    <nav
      aria-label={uk.pages.inbox.title}
      className="sticky top-0 z-10 border-b border-border bg-surface p-2"
    >
      <div className="flex rounded-lg bg-chip p-1">
        {(['chats', 'forms'] as const).map((key) => (
          <Button
            key={key}
            asChild
            variant={mode === key ? 'tabActive' : 'tab'}
            className="flex-1"
          >
            <Link
              href={key === 'forms' ? '/inbox?tab=forms' : '/inbox'}
              aria-current={mode === key ? 'page' : undefined}
              scroll={false}
            >
              {uk.inbound[key]}
            </Link>
          </Button>
        ))}
      </div>
    </nav>
  );
}
