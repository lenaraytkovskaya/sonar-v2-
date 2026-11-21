import Link from 'next/link';
import { PageHeader } from '@/components/shared';
import { UsersPanel } from '@/components/users-panel';
import { uk } from '@/i18n/uk';

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader
        title={uk.users.title}
        description={uk.users.description}
        actions={
          <Link
            href="/settings"
            className="inline-flex min-h-9 items-center rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-xs hover:bg-raised"
          >
            {uk.users.back}
          </Link>
        }
      />
      <UsersPanel />
    </div>
  );
}
