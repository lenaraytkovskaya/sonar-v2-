import { PageHeader } from '@/components/shared';
import { ChannelTabs } from '@/components/channel-tabs';
import { uk } from '@/i18n/uk';
export default async function Page() {
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const { listTelegramAccounts } = await import('@sonar/db/telegram');
  const { listWhatsAppAccounts } = await import('@sonar/db/whatsapp');
  const {
    listSocialAccounts,
    getSocialProxyCount,
    getSocialAccountProxyIndex,
  } = await import('@sonar/db/social-accounts');
  const [email, forms, manual, telegram, whatsapp, social, accountProxyIndex] =
    await Promise.all([
      listEmailAccounts(),
      listFormAccounts(),
      listManualFormMessages(),
      listTelegramAccounts(),
      listWhatsAppAccounts(),
      listSocialAccounts(),
      getSocialAccountProxyIndex(),
    ]);
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <ChannelTabs
        email={{ accounts: email }}
        social={{
          accounts: social,
          proxyCount: getSocialProxyCount(),
          accountProxyIndex,
        }}
        telegram={{
          accounts: telegram,
          configured: !!(
            process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH
          ),
        }}
        forms={{ accounts: forms, manual }}
        whatsapp={{
          accounts: whatsapp,
          configured: !!(process.env.WAHA_URL && process.env.WAHA_API_KEY),
        }}
      />
    </>
  );
}
