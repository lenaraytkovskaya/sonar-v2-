import { PageHeader } from '@/components/shared';
import { FormAccounts } from '@/components/form-accounts';
import { TelegramAccounts } from '@/components/telegram-accounts';
import { WhatsAppAccounts } from '@/components/whatsapp-accounts';
import { EmailAccounts } from '@/components/email-accounts';
import { SendTestMode } from '@/components/send-test-mode';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const { listTelegramAccounts } = await import('@sonar/db/telegram');
  const { listWhatsAppAccounts } = await import('@sonar/db/whatsapp');
  const { sonarPool } = await import('@sonar/db');
  const [email, forms, manual, telegram, whatsapp, testRows] =
    await Promise.all([
      listEmailAccounts(),
      listFormAccounts(),
      listManualFormMessages(),
      listTelegramAccounts(),
      listWhatsAppAccounts(),
      sonarPool.query(
        "select key,value from settings where key in ('send.test_mode','send.test_allowlist')",
      ),
    ]);
  const test = Object.fromEntries(
    testRows.rows.map((row) => [row.key, row.value]),
  );
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <div className="space-y-5">
        <SendTestMode
          enabled={test['send.test_mode'] !== false}
          allowlist={
            Array.isArray(test['send.test_allowlist'])
              ? test['send.test_allowlist']
              : []
          }
        />
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
