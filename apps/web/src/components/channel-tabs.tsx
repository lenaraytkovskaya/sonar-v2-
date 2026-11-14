'use client';
import { useId, useState, type ComponentProps } from 'react';
import { EmailAccounts } from './email-accounts';
import { SocialAccounts } from './social-accounts';
import { TelegramAccounts } from './telegram-accounts';
import { FormAccounts } from './form-accounts';
import { WhatsAppAccounts } from './whatsapp-accounts';
import { Button } from './ui/button';
import { uk } from '@/i18n/uk';

type Network = ComponentProps<typeof SocialAccounts>['network'];
export function ChannelTabs({
  email,
  social,
  telegram,
  forms,
  whatsapp,
}: {
  email: ComponentProps<typeof EmailAccounts>;
  social: Omit<ComponentProps<typeof SocialAccounts>, 'network' | 'active'>;
  telegram: ComponentProps<typeof TelegramAccounts>;
  forms: ComponentProps<typeof FormAccounts>;
  whatsapp: ComponentProps<typeof WhatsAppAccounts>;
}) {
  const id = useId();
  const [active, setActive] = useState('email');
  const [visited, setVisited] = useState<string[]>(['email']);
  const tabs = [
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
      key: 'forms',
      label: uk.campaign.channelNames.forms,
      content: <FormAccounts {...forms} />,
    },
    {
      key: 'whatsapp',
      label: uk.campaign.channelNames.whatsapp,
      content: <WhatsAppAccounts {...whatsapp} />,
    },
  ];
  const select = (key: string) => {
    setActive(key);
    setVisited((previous) =>
      previous.includes(key) ? previous : [...previous, key],
    );
  };
  return (
    <div className="min-w-0 space-y-4">
      <div
        role="tablist"
        aria-label={uk.pages.channels.title}
        className="flex gap-2 overflow-x-auto p-1"
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
            variant={active === tab.key ? 'default' : 'outline'}
            className="min-h-11 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
      <p className="text-xs text-muted-foreground">
        {uk.pages.channels.drafts}
      </p>
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
          {visited.includes(tab.key) && tab.content}
        </div>
      ))}
    </div>
  );
}
