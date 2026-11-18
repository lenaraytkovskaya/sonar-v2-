'use client';
import { useEffect, useId, type ComponentProps } from 'react';
import { useUrlTab } from './use-url-tab';
import { ContactDetails } from './contact-details';
import { EmailAccounts } from './email-accounts';
import { SocialAccounts } from './social-accounts';
import { TelegramAccounts } from './telegram-accounts';
import { WhatsAppAccounts } from './whatsapp-accounts';
import { ViberAccounts } from './viber-accounts';
import { Button } from './ui/button';
import { uk } from '@/i18n/uk';

type Network = ComponentProps<typeof SocialAccounts>['network'];
export function ChannelTabs({
  email,
  contactDetails,
  social,
  telegram,
  whatsapp,
  viber,
}: {
  email: ComponentProps<typeof EmailAccounts>;
  contactDetails: ComponentProps<typeof ContactDetails>;
  social: Omit<ComponentProps<typeof SocialAccounts>, 'network' | 'active'>;
  telegram: ComponentProps<typeof TelegramAccounts>;
  whatsapp: ComponentProps<typeof WhatsAppAccounts>;
  viber: ComponentProps<typeof ViberAccounts>;
}) {
  const id = useId();
  const { active, select, visited } = useUrlTab(
    [
      'contact-details',
      'email',
      ...Object.keys(uk.social.networks),
      'telegram',
      'whatsapp',
      'viber',
    ],
    'contact-details',
  );
  useEffect(() => {
    document.getElementById(`${id}-tab-${active}`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [id, active]);
  const tabs = [
    {
      key: 'contact-details',
      label: uk.forms.contactDetails,
      content: <ContactDetails {...contactDetails} />,
    },
    {
      key: 'email',
      label: uk.campaign.channelNames.email,
      content: <EmailAccounts {...email} />,
    },
    // Keep the existing social-network order from the dictionary.
    ...(Object.keys(uk.social.networks) as Network[]).map((network) => ({
      key: network,
      label: uk.social.networks[network],
      content: (
        <SocialAccounts
          {...social}
          network={network}
          active={active === network}
        />
      ),
    })),
    {
      key: 'telegram',
      label: uk.campaign.channelNames.telegram,
      content: <TelegramAccounts {...telegram} />,
    },
    {
      key: 'whatsapp',
      label: uk.campaign.channelNames.whatsapp,
      content: <WhatsAppAccounts {...whatsapp} />,
    },
    {
      key: 'viber',
      label: uk.campaign.channelNames.viber,
      content: <ViberAccounts {...viber} />,
    },
  ];
  return (
    <div className="min-w-0 space-y-4">
      <div
        role="tablist"
        aria-label={uk.pages.channels.title}
        className="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-chip p-1"
      >
        {tabs.map((tab, index) => (
          <Button
            key={tab.key}
            id={`${id}-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            aria-controls={`${id}-panel-${tab.key}`}
            tabIndex={active === tab.key ? 0 : -1}
            variant={active === tab.key ? 'tabActive' : 'tab'}
            className="shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={(event) => {
              select(tab.key);
              event.currentTarget.scrollIntoView({
                block: 'nearest',
                inline: 'nearest',
              });
            }}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + tabs.length) % tabs.length
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const target = tabs[next];
              if (!target) return;
              select(target.key);
              document.getElementById(`${id}-tab-${target.key}`)?.focus();
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`${id}-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tab.key}`}
          hidden={active !== tab.key}
          tabIndex={0}
        >
          {/* Mount on first visit and retain forms without repeating mount effects. */}
          {(active === tab.key || visited.includes(tab.key)) && tab.content}
        </div>
      ))}
    </div>
  );
}
