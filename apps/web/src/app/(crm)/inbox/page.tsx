import Link from 'next/link';
import { redirect } from 'next/navigation';
import { uk } from '@/i18n/uk';
import { ChannelIcon } from '@/components/channel-icon';
import { StatusBadge } from '@/components/shared';
import { validId } from '@/lib/api-access';
import {
  channelLabel,
  contactLabel,
  messageStatus,
} from '@/lib/outreach-labels';
import { cn } from '@/lib/utils';
import { Card, PageHeader } from '@/components/shared';
import { ConversationChat } from '@/components/conversation-chat';
import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
const channels = ['email', 'telegram', 'whatsapp', 'form', 'social', 'call'];
const statuses = [...Object.keys(uk.email.statuses), 'skipped'];
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    campaignId?: string;
    channel?: string;
    status?: string;
    conversation?: string;
    contact?: string;
    needsHuman?: string;
    unread?: string;
  }>;
}) {
  const query = await searchParams;
  // A click on a company contact lands here: open (or start) that contact's dialog.
  if (validId(query.contact)) {
    const { ensureContactConversation } = await import('@sonar/db/inbound');
    const conversationId = await ensureContactConversation(
      query.contact,
      validId(query.campaignId) ? query.campaignId : undefined,
    ).catch(() => null);
    if (conversationId) redirect(`/inbox?conversation=${conversationId}`);
  }
  const filters = {
    campaignId: validId(query.campaignId) ? query.campaignId : undefined,
    channel: channels.includes(query.channel ?? '') ? query.channel : undefined,
    status: statuses.includes(query.status ?? '') ? query.status : undefined,
    needsHuman: query.needsHuman === '1' ? true : undefined,
    unread: query.unread === '1' ? true : undefined,
  };
  const { getInbox } = await import('@sonar/db/outreach');
  const { getConversationChat } = await import('@sonar/db/inbound');
  const inbox = await getInbox(filters);
  const selected =
    inbox.conversations.find((row) => row.id === query.conversation) ??
    inbox.conversations[0];
  const chat = selected ? await getConversationChat(selected.id) : null;
  const conversationLink = (id: string) => {
    const params = new URLSearchParams({ conversation: id });
    for (const [key, value] of Object.entries(filters))
      if (value) params.set(key, typeof value === 'boolean' ? '1' : value);
    return `/inbox?${params}`;
  };
  const selectClass =
    'min-h-11 rounded-lg border border-border bg-surface px-3 text-sm';
  return (
    <>
      <PageHeader
        title={uk.pages.inbox.title}
        description={uk.pages.inbox.description}
      />
      <form className="mb-4 flex flex-wrap gap-3">
        <select
          aria-label={uk.company.campaign}
          name="campaignId"
          defaultValue={filters.campaignId ?? ''}
          className={selectClass}
        >
          <option value="">
            {uk.company.campaign}: {uk.company.all}
          </option>
          {inbox.campaigns.map((campaign) => (
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
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        <Card className="min-w-0 overflow-hidden">
          {!inbox.conversations.length && (
            <p className="p-5 text-sm text-muted-foreground">
              {uk.pages.inbox.empty}
            </p>
          )}
          {inbox.conversations.map((row) => (
            <Link
              key={row.id}
              href={conversationLink(row.id)}
              aria-current={selected?.id === row.id ? 'true' : undefined}
              className={cn(
                'block space-y-1 border-b border-border p-4 text-sm last:border-b-0 hover:bg-raised',
                selected?.id === row.id && 'bg-chip',
              )}
            >
              <p className="flex items-center gap-2 font-semibold">
                {row.companyName || uk.inbound.unknownCompany}
                {row.unreadCount > 0 && (
                  <span className="rounded-full bg-err-bg px-2 text-err">
                    {row.unreadCount}
                  </span>
                )}
              </p>
              {row.needsHuman && (
                <p className="text-xs text-wait">{uk.inbound.needsHuman}</p>
              )}
              <p className="break-words">
                <ChannelIcon
                  channel={row.channel}
                  value={row.contactValue ?? ''}
                />{' '}
                {channelLabel(row.channel, row.contactValue ?? '')} ·{' '}
                {contactLabel(row.contactValue)}
              </p>
              <p className="line-clamp-2 text-muted-foreground">
                {row.lastMessage || uk.email.noMessages}
              </p>
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {row.lastStatus && (
                  <StatusBadge status={row.lastStatus}>
                    {messageStatus(row.lastStatus)}
                  </StatusBadge>
                )}
                {row.lastAt && <LocalTime value={row.lastAt} />}
              </div>
            </Link>
          ))}
        </Card>
        {chat && selected ? (
          <ConversationChat key={selected.id} initial={chat} />
        ) : (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {uk.outreach.selectConversation}
          </Card>
        )}
      </div>
    </>
  );
}
