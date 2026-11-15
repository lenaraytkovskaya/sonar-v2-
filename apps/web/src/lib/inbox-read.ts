/** The boundary is the ordered, rendered snapshot, never the next poll's data. */
export function inboxReadSnapshot(
  incoming: readonly { id: string; unread: boolean }[],
  view: {
    active: boolean;
    followingLatest: boolean;
    newMessages: number;
    conversationId?: string;
    selectedId?: string;
  },
) {
  if (
    !view.active ||
    !view.followingLatest ||
    view.newMessages > 0 ||
    !view.conversationId ||
    view.conversationId !== view.selectedId ||
    !incoming.some((message) => message.unread)
  )
    return null;
  const visibleMessageIds = incoming.map((message) => message.id);
  return {
    action: 'read' as const,
    messageId: visibleMessageIds.at(-1)!,
    visibleMessageIds,
  };
}
