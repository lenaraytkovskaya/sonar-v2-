import { SettingsPanel } from '@/components/settings-panel';
import { NotificationSettings } from '@/components/message-notifier';
import { PageHeader } from '@/components/shared';
import Link from 'next/link';
import { uk } from '@/i18n/uk';
export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader
        {...uk.pages.settings}
        actions={
          <Link
            href="/demo"
            className="inline-flex min-h-9 items-center rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-xs hover:bg-raised"
          >
            {uk.demo.link}
          </Link>
        }
      />
      <NotificationSettings />
      <SettingsPanel />
    </div>
  );
}
