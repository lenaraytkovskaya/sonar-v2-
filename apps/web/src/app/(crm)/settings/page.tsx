import { SettingsPanel } from '@/components/settings-panel';
import { NotificationSettings } from '@/components/message-notifier';
import { PageHeader } from '@/components/shared';
import { uk } from '@/i18n/uk';
export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader {...uk.pages.settings} />
      <NotificationSettings />
      <SettingsPanel />
    </div>
  );
}
