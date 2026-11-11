import { PageHeader } from '@/components/shared';
import { EmailAccounts } from '@/components/email-accounts';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts } = await import('@sonar/db/email');
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <EmailAccounts accounts={await listEmailAccounts()} />
    </>
  );
}
