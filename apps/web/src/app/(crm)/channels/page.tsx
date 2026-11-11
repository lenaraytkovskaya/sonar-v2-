import { PageHeader } from '@/components/shared';
import { FormAccounts } from '@/components/form-accounts';
import { EmailAccounts } from '@/components/email-accounts';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const [email, forms, manual] = await Promise.all([
    listEmailAccounts(),
    listFormAccounts(),
    listManualFormMessages(),
  ]);
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <div className="space-y-5">
        <EmailAccounts accounts={email} />
        <FormAccounts accounts={forms} manual={manual} />
      </div>
    </>
  );
}
