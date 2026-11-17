import { PageHeader, StatusBadge } from '@/components/shared';
import { CompanyTable } from '@/components/company-table';
import type { CompanyCardRow } from '@/components/company-card';
import { ChannelIcon } from '@/components/channel-icon';
import { MessageBubble, type ChatMessage } from '@/components/company-email';
import { Button } from '@/components/ui/button';
import { Callout, DetailList, InfoTip, Section } from '@/components/ui/layout';
import { uk } from '@/i18n/uk';

/** UI showcase with invented data only: nothing here reads or writes the database. */
const t = uk.demo;
const day = (offset: number, hour = 10) =>
  new Date(Date.UTC(2026, 10, 16 - offset, hour, 15)).toISOString();

const companies: CompanyCardRow[] = (
  [
    ['Автосервіс «Гвинт»', 'new', null, ['phone'], 'Київ'],
    [
      'СТО «Мотор Плюс»',
      'ready',
      82.4,
      ['email', 'phone', 'telegram'],
      'Львів',
    ],
    ['Шиномонтаж «Колесо»', 'contacted', 64.1, ['email', 'phone'], 'Одеса'],
    [
      'Детейлінг «Блиск»',
      'replied',
      71.9,
      ['email', 'whatsapp', 'social'],
      'Київ',
    ],
    ['Автоцентр «Схід»', 'deal', 90.2, ['email', 'phone', 'form'], 'Харків'],
    ['Кузовний цех «Рихтуй»', 'do_not_contact', 35.5, ['phone'], 'Дніпро'],
  ] as const
).map(([name, status, score, channels, city], index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name,
  city,
  primary_type: 'car_repair',
  rating: (4.1 + index * 0.15).toFixed(1),
  ratings_count: 20 + index * 37,
  score,
  fit: null,
  website: `https://example${index}.ua`,
  domain: `example${index}.ua`,
  status,
  created_at: day(index),
  phones: (channels as readonly string[]).includes('phone')
    ? [`+38067000000${index}`]
    : [],
  emails: (channels as readonly string[]).includes('email')
    ? [`info@example${index}.ua`]
    : [],
  channels: [...channels],
  registry: index % 2 === 0,
  platform: false,
  chain_size: index === 4 ? 3 : 1,
  campaigns: [],
}));

const message = (fields: Record<string, unknown>) =>
  ({
    id: 'demo',
    direction: 'out',
    channel: 'email',
    status: 'sent',
    source: 'ai',
    subject: null,
    body: '',
    classification: null,
    needsHuman: false,
    providerTimestampUnknown: false,
    reasonUk: null,
    toValue: 'info@example1.ua',
    sentAt: day(0),
    createdAt: day(0),
    ...fields,
  }) as unknown as ChatMessage;

const chat: { note: string; message: ChatMessage }[] = [
  {
    note: t.chat.sent,
    message: message({ body: t.chat.firstMessage, sentAt: day(2, 9) }),
  },
  {
    note: t.chat.delivered,
    message: message({
      status: 'delivered',
      body: t.chat.followUp,
      sentAt: day(1, 9),
    }),
  },
  {
    note: t.chat.read,
    message: message({
      status: 'read',
      channel: 'telegram',
      body: t.chat.short,
      sentAt: day(1, 12),
    }),
  },
  {
    note: t.chat.failed,
    message: message({
      status: 'failed',
      channel: 'whatsapp',
      body: t.chat.short,
      reasonUk: t.chat.failedReason,
    }),
  },
  {
    note: t.chat.reply,
    message: message({
      direction: 'in',
      source: 'inbound',
      body: t.chat.replyText,
      classification: 'price',
      needsHuman: true,
      sentAt: day(0, 14),
    }),
  },
];

const accounts = [
  {
    name: 'sonar_md_',
    network: 'instagram',
    status: 'active',
    label: t.accounts.active,
    note: t.accounts.activeNote,
  },
  {
    name: 'Sonar Dev',
    network: 'linkedin',
    status: 'needs_login',
    label: t.accounts.needsLogin,
    note: t.accounts.needsLoginNote,
    callout: ['err', t.accounts.needsLoginReason],
  },
  {
    name: 'Mero Solis',
    network: 'facebook',
    status: 'paused',
    label: t.accounts.captcha,
    note: t.accounts.captchaNote,
    callout: ['wait', uk.socialAccounts.captchaHelp],
  },
  {
    name: 'sonar@cryid.com',
    network: 'email',
    status: 'paused',
    label: t.accounts.code,
    note: t.accounts.codeNote,
    callout: ['wait', uk.socialAccounts.emailCode],
  },
] as const;

const failures = [
  {
    title: t.failures.budget,
    status: 'paused',
    reason: t.failures.budgetReason,
    note: t.failures.budgetNote,
  },
  {
    title: t.failures.site,
    status: 'failed',
    reason: t.failures.siteReason,
    note: t.failures.siteNote,
  },
  {
    title: t.failures.login,
    status: 'paused',
    reason: t.failures.loginReason,
    note: t.failures.loginNote,
  },
  {
    title: t.failures.send,
    status: 'failed',
    reason: t.failures.sendReason,
    note: t.failures.sendNote,
  },
] as const;

function Note({ children }: { children: string }) {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      <span className="font-medium text-foreground">{t.watch}: </span>
      {children}
    </p>
  );
}

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title={t.title} description={t.description} />
      <Callout tone="run">{t.banner}</Callout>

      <Section title={t.kpiTitle} description={t.kpiNote}>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {(
            [
              [uk.overview.stages.found, 248, `+31 ${t.kpiWeek}`],
              [
                uk.overview.stages.ready,
                173,
                `70% ${uk.overview.kpiNotes.ofFound}`,
              ],
              [
                uk.overview.stages.contacted,
                96,
                `55% ${uk.overview.kpiNotes.ofReady}`,
              ],
              [
                uk.overview.stages.replied,
                14,
                `15% ${uk.overview.kpiNotes.ofContacted}`,
              ],
            ] as const
          ).map(([label, value, note]) => (
            <li key={label} className="rounded-lg border border-border p-5">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-1 font-heading text-3xl font-bold tabular-nums">
                {value}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">{note}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={uk.tasks.failures} description={t.failures.intro}>
        <ul className="divide-y divide-border">
          {failures.map((item) => (
            <li
              key={item.title}
              className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {item.title}
                  <StatusBadge status={item.status}>
                    {uk.tasks.status[item.status]}
                  </StatusBadge>
                </p>
                <p
                  className={
                    item.status === 'paused'
                      ? 'text-sm text-wait'
                      : 'text-sm text-err'
                  }
                >
                  {item.reason}
                </p>
                <Note>{item.note}</Note>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" disabled>
                  {uk.tasks.dismiss}
                </Button>
                <Button variant="outline" disabled>
                  {uk.tasks.retry}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={
          <span className="inline-flex items-center gap-2">
            {uk.pages.companies.title}
            <InfoTip>{t.companiesHelp}</InfoTip>
          </span>
        }
        description={t.companiesNote}
      >
        <div className="hidden md:block">
          <CompanyTable companies={companies} link={() => '/demo'} />
        </div>
        <ul className="space-y-2 md:hidden">
          {companies.map((company) => (
            <li key={company.id} className="text-sm">
              {company.name}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={uk.pages.channels.title} description={t.accounts.intro}>
        <div className="space-y-4">
          {accounts.map((account) => (
            <article
              key={account.name}
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chip">
                    <ChannelIcon channel={account.network} />
                  </span>
                  <h3 className="truncate font-semibold">{account.name}</h3>
                  <StatusBadge status={account.status}>
                    {account.label}
                  </StatusBadge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={
                      account.status === 'needs_login' ? 'default' : 'outline'
                    }
                    disabled
                  >
                    {uk.socialAccounts.retryLogin}
                  </Button>
                  <Button variant="outline" disabled>
                    {uk.socialAccounts.check}
                  </Button>
                </div>
              </div>
              <DetailList
                items={[
                  { label: uk.email.today, value: '3 / 20' },
                  {
                    label: uk.socialAccounts.proxy,
                    value: `${uk.socialAccounts.proxy} 7 · sol.ua-proxy.net`,
                  },
                  { label: uk.social.checked, value: '16.11.2026, 21:03' },
                ]}
              />
              {'callout' in account && (
                <Callout tone={account.callout[0]}>
                  {account.callout[1]}
                </Callout>
              )}
              <Note>{account.note}</Note>
            </article>
          ))}
        </div>
      </Section>

      <Section title={uk.pages.inbox.title} description={t.chat.intro}>
        <div className="space-y-4">
          {chat.map((item, index) => (
            <div key={index} className="space-y-1.5">
              <MessageBubble message={item.message} />
              <p
                className={
                  item.message.direction === 'in'
                    ? 'text-xs text-muted-foreground'
                    : 'text-right text-xs text-muted-foreground'
                }
              >
                {item.note}
              </p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
