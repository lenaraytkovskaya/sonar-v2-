import {
  LayoutDashboard,
  Megaphone,
  Building2,
  Inbox,
  Radio,
  Wallet,
  Settings,
} from 'lucide-react';
import { uk } from '@/i18n/uk';
import { EmptyState, PageHeader } from '@/components/shared';
const icons = {
  overview: LayoutDashboard,
  campaigns: Megaphone,
  companies: Building2,
  company: Building2,
  inbox: Inbox,
  channels: Radio,
  finance: Wallet,
  settings: Settings,
};
export function Placeholder({ page }: { page: keyof typeof icons }) {
  const text = uk.pages[page];
  const Icon = icons[page];
  return (
    <>
      <PageHeader title={text.title} description={text.description} />
      <EmptyState
        title={text.empty}
        description={text.detail}
        icon={<Icon className="size-8" />}
      />
    </>
  );
}
