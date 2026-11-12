import { PageHeader } from '@/components/shared';
import { FormAccounts } from '@/components/form-accounts';
import { TelegramAccounts } from '@/components/telegram-accounts';
import { WhatsAppAccounts } from '@/components/whatsapp-accounts';
import { EmailAccounts } from '@/components/email-accounts';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const { listTelegramAccounts } = await import('@sonar/db/telegram');
  const { listWhatsAppAccounts } = await import('@sonar/db/whatsapp');
  const [email, forms, manual, telegram, whatsapp] = await Promise.all([
    listEmailAccounts(),
    listFormAccounts(),
    listManualFormMessages(),
    listTelegramAccounts(),
    listWhatsAppAccounts(),
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
        <WhatsAppAccounts
          accounts={whatsapp}
          configured={!!(process.env.WAHA_URL && process.env.WAHA_API_KEY)}
        />
      </div>
    </>
  );
}
