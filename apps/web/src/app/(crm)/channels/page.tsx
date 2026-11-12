import { PageHeader } from '@/components/shared';
import { FormAccounts } from '@/components/form-accounts';
import { TelegramAccounts } from '@/components/telegram-accounts';
import { EmailAccounts } from '@/components/email-accounts';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const { listTelegramAccounts } = await import('@sonar/db/telegram');
  const [email, forms, manual, telegram] = await Promise.all([
    listEmailAccounts(),
    listFormAccounts(),
    listManualFormMessages(),
    listTelegramAccounts(),
  ]);
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <div className="space-y-5">
        <EmailAccounts accounts={email} />
        <TelegramAccounts
          accounts={telegram}
          configured={
            !!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH)
          }
        />
        <FormAccounts accounts={forms} manual={manual} />
      </div>
    </>
  );
}
