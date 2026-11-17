'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { getInbox } from '@sonar/db/outreach';
import type { getConversationChat } from '@sonar/db/inbound';
import { uk } from '@/i18n/uk';
import {
  inboxChannels as channels,
  inboxStatuses as statuses,
  type inboxFilters,
} from '@/lib/inbox-filters';
import { useInboxPolling } from '@/components/use-inbox-polling';
import {
  channelLabel,
  contactLabel,
  messageStatus,
} from '@/lib/outreach-labels';
import { cn } from '@/lib/utils';
import { splitEmailHistory } from '@/lib/email-display';
import { Card } from '@/components/shared';
import { ConversationChat } from '@/components/conversation-chat';
import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
import { InboxModeTabs } from './inbox-mode-tabs';
import { ChannelIcon } from './channel-icon';
export function Inbox({
  initial,
  chat,
  selectedId,
  explicitSelection,
  filters,
}: {
  initial: Awaited<ReturnType<typeof getInbox>>;
  chat: Awaited<ReturnType<typeof getConversationChat>> | null;
  selectedId?: string;
  explicitSelection: boolean;
  filters: ReturnType<typeof inboxFilters>;
}) {
  const [data, setData] = useState(initial);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setData(initial);
  }, [initial]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) params.set(key, typeof value === 'boolean' ? '1' : value);
  const { error } = useInboxPolling(
    `/api/conversations?${params}`,
    async (signal) => {
      const response = await fetch(`/api/conversations?${params}`, {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw Error();
      const next = await response.json();
      if (!signal.aborted) setData(next);
    },
  );
  const conversationLink = (id: string) => {
    const params = new URLSearchParams({ conversation: id });
    for (const [key, value] of Object.entries(filters))
      if (value) params.set(key, typeof value === 'boolean' ? '1' : value);
    return `/inbox?${params}`;
  };
  const selectClass =
    'min-h-11 rounded-lg border border-border bg-surface px-3 text-sm';
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className={cn('shrink-0', explicitSelection && 'hidden lg:block')}>
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          {uk.pages.inbox.title}
        </h1>
        <details className="mt-2 max-h-[calc(var(--inbox-height,100dvh)*0.35)] overflow-y-auto">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {uk.inbound.filters}
          </summary>
          <form className="mt-2 grid grid-cols-2 gap-2 lg:flex lg:flex-wrap [&>select]:min-w-0 [&>select]:max-w-full">
            <select
              aria-label={uk.company.campaign}
              name="campaignId"
              defaultValue={filters.campaignId ?? ''}
              className={selectClass}
            >
              <option value="">
                {uk.company.campaign}: {uk.company.all}
              </option>
              {data.campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
            <select
              aria-label={uk.forms.channel}
              name="channel"
              defaultValue={filters.channel ?? ''}
              className={selectClass}
            >
              <option value="">
                {uk.forms.channel}: {uk.company.all}
              </option>
              {channels.map((channel) => (
                <option key={channel} value={channel}>
                  {channelLabel(channel)}
                </option>
              ))}
            </select>
            <select
              aria-label={uk.company.status}
              name="status"
              defaultValue={filters.status ?? ''}
              className={selectClass}
            >
              <option value="">
                {uk.company.status}: {uk.company.all}
              </option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {messageStatus(status)}
                </option>
              ))}
            </select>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="needsHuman"
                value="1"
                defaultChecked={filters.needsHuman}
              />
              {uk.inbound.needsHuman}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="unread"
                value="1"
                defaultChecked={filters.unread}
              />
              {uk.inbound.unread}
            </label>
            <Button type="submit">{uk.company.apply}</Button>
          </form>
        </details>
      </div>
      {error && (
        <p role="status" className="shrink-0 text-sm text-err">
          {uk.inbound.refreshError}
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]">
        <Card
          role="navigation"
          aria-label={uk.inbound.dialogs}
          className={cn(
            'min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain',
            explicitSelection && 'hidden lg:block',
          )}
        >
          <InboxModeTabs mode="chats" />
          {!data.conversations.length && (
            <p className="p-5 text-sm text-muted-foreground">
              {uk.pages.inbox.empty}
            </p>
          )}
          {data.conversations.map((row) => (
            <Link
              scroll={false}
              key={row.id}
              href={conversationLink(row.id)}
              aria-current={selectedId === row.id ? 'true' : undefined}
              className={cn(
                'block min-w-0 space-y-1 border-b border-border px-4 py-3 text-sm last:border-b-0 hover:bg-raised',
                selectedId === row.id && 'bg-chip hover:bg-chip',
              )}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 font-medium">
                  <span className="truncate">
                    {row.companyName || uk.inbound.unknownCompany}
                  </span>
                  {row.unreadCount > 0 && (
                    <span className="shrink-0 rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-foreground tabular-nums">
                      {row.unreadCount}
                    </span>
                  )}
                </p>
                {row.lastAt && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <LocalTime value={row.lastAt} />
                  </span>
                )}
              </div>
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <ChannelIcon
                  channel={row.channel}
                  value={row.contactValue ?? ''}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">
                  {channelLabel(row.channel, row.contactValue ?? '')} ·{' '}
                  {contactLabel(row.contactValue)}
                </span>
              </p>
              <p className="line-clamp-2 break-words text-muted-foreground [overflow-wrap:anywhere]">
                {row.lastMessage
                  ? splitEmailHistory(row.lastMessage, row.channel).current
                  : uk.email.noMessages}
              </p>
              {(row.needsHuman || row.lastStatus) && (
                <p className="flex flex-wrap gap-x-2 text-xs">
                  {row.needsHuman && (
                    <span className="text-wait">{uk.inbound.needsHuman}</span>
                  )}
                  {row.lastStatus && (
                    <span className="text-muted-foreground">
                      {messageStatus(row.lastStatus, {
                        channel: row.channel,
                        toValue: row.contactValue,
                        reasonUk: row.lastReasonUk,
                      })}
                    </span>
                  )}
                </p>
              )}
            </Link>
          ))}
        </Card>
        {chat && selectedId ? (
          <div
            className={cn(
              'h-full min-h-0 min-w-0',
              !explicitSelection && 'hidden lg:block',
            )}
          >
            <ConversationChat
              key={selectedId}
              initial={chat}
              active={explicitSelection || desktop}
              backHref={conversationLink('').replace(/conversation=&?/, '')}
            />
          </div>
        ) : (
          <Card
            className={cn(
              'p-8 text-center text-sm text-muted-foreground',
              !explicitSelection && 'hidden lg:block',
            )}
          >
            {uk.outreach.selectConversation}
            {explicitSelection && (
              <Link
                className="block min-h-11 text-accent lg:hidden"
                href={conversationLink('').replace(/conversation=&?/, '')}
              >
                {uk.inbound.backToDialogs}
              </Link>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
