import { SettingsPanel } from '@/components/settings-panel';
import { NotificationSettings } from '@/components/message-notifier';
export default function Page() {
  return (
    <div className="space-y-4">
      <NotificationSettings />
      <SettingsPanel />
    </div>
  );
}
