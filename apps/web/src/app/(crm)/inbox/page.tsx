import { redirect } from 'next/navigation';
import { validId } from '@/lib/api-access';
import { inboxFilters } from '@/lib/inbox-filters';
import { Inbox } from '@/components/inbox';
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
  const filters = inboxFilters(query);
  const { getInbox } = await import('@sonar/db/outreach');
  const { getConversationChat } = await import('@sonar/db/inbound');
  const inbox = await getInbox(filters);
  const selectedId = validId(query.conversation)
    ? query.conversation
    : inbox.conversations[0]?.id;
  const chat = selectedId ? await getConversationChat(selectedId) : null;
  return (
    <Inbox
      initial={inbox}
      chat={chat}
      selectedId={selectedId}
      explicitSelection={!!query.conversation}
      filters={filters}
    />
  );
}
