import { PageHeader } from '@/components/shared';
import { ChannelTabs } from '@/components/channel-tabs';
import { uk } from '@/i18n/uk';
import { getSession } from '@/lib/auth';
export default async function Page() {
  const user = (await getSession()).user;
  const { listEmailAccounts, listFormAccounts } =
    await import('@sonar/db/email');
  const { listManualFormMessages } = await import('@sonar/db/forms');
  const { accountHealth } = await import('@sonar/db/account-health');
  const { listTelegramAccounts } = await import('@sonar/db/telegram');
  const { listWhatsAppAccounts } = await import('@sonar/db/whatsapp');
  const {
    listSocialAccounts,
    getSocialProxyCount,
    getSocialProxyLabels,
    getSocialAccountProxyIndex,
  } = await import('@sonar/db/social-accounts');
  const [
    email,
    forms,
    manual,
    telegram,
    whatsapp,
    social,
    accountProxyIndex,
    health,
  ] = await Promise.all([
    listEmailAccounts(),
    listFormAccounts(),
    listManualFormMessages(),
    listTelegramAccounts(),
    listWhatsAppAccounts(),
    listSocialAccounts(user?.id),
    Promise.all([
      getSocialAccountProxyIndex('facebook'),
      getSocialAccountProxyIndex('instagram'),
      getSocialAccountProxyIndex('linkedin'),
    ]),
    accountHealth(),
  ]);
  return (
    <>
      <PageHeader {...uk.pages.channels} />
      <ChannelTabs
        email={{ accounts: email, health }}
        social={{
          accounts: social,
          health,
          proxyCount: getSocialProxyCount(),
          proxyLabels: getSocialProxyLabels(),
          accountProxyIndexes: {
            facebook: accountProxyIndex[0],
            instagram: accountProxyIndex[1],
            linkedin: accountProxyIndex[2],
          },
        }}
        telegram={{
          accounts: telegram,
          health,
          configured: !!(
            process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH
          ),
        }}
        forms={{ accounts: forms, manual }}
        whatsapp={{
          accounts: whatsapp,
          health,
          configured: !!(process.env.WAHA_URL && process.env.WAHA_API_KEY),
        }}
      />
    </>
  );
}
