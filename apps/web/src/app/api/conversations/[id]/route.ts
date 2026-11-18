import { expectedDraft } from '@/lib/draft-state';
import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const invalid = () => Response.json({ error: uk.ai.invalid }, { status: 400 });
export async function GET(request: Request, context: Context) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id)) return invalid();
  const response = await emailResponse(async () => {
    const taskId = new URL(request.url).searchParams.get('taskId');
    if (taskId) {
      if (!validId(taskId)) return invalid();
      const { getConversationReplyTask } = await import('@sonar/db/inbound');
      return (
        (await getConversationReplyTask(id, taskId)) ??
        Response.json({ error: uk.tasks.missing }, { status: 404 })
      );
    }
    const { getConversationChat } = await import('@sonar/db/inbound');
    const chat = await getConversationChat(id);
    return chat.conversation
      ? chat
      : Response.json({ error: uk.tasks.missing }, { status: 404 });
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !data) return invalid();
  const expected = expectedDraft(data.expected);
  if (expected === false) return invalid();
  return emailResponse(async () => {
    const db = await import('@sonar/db/inbound');
    const chat = await db.getConversationChat(id);
    if (!chat.conversation) return invalid();
    if (data.action === 'repair-whatsapp-identity') {
      if (!validId(data.requestId) || typeof data.dryRun !== 'boolean')
        return invalid();
      return Response.json(
        await db.enqueueWhatsAppIdentityRepair(
          id,
          user.id,
          data.requestId,
          data.dryRun,
        ),
        { status: 202 },
      );
    }
    if (data.action === 'read') {
      const incomingIds = new Set(
        chat.messages.filter((m) => m.direction === 'in').map((m) => m.id),
      );
      if (
        !validId(data.messageId) ||
        !Array.isArray(data.visibleMessageIds) ||
        !data.visibleMessageIds.includes(data.messageId) ||
        data.visibleMessageIds.length > incomingIds.size ||
        new Set(data.visibleMessageIds).size !==
          data.visibleMessageIds.length ||
        !data.visibleMessageIds.every(
          (id: unknown) => validId(id) && incomingIds.has(id),
        ) ||
        !incomingIds.has(data.messageId)
      )
        return invalid();
      await db.markConversationRead(id, data.messageId, data.visibleMessageIds);
      return { ok: true };
    }
    if (data.action === 'generate') {
      if (!validId(data.requestId)) return invalid();
      return Response.json(await db.enqueueReply(id, data.requestId, user.id), {
        status: 202,
      });
    }
    if (data.action === 'reply') {
      if (
        !validId(data.requestId) ||
        typeof data.body !== 'string' ||
        !data.body.trim() ||
        data.body.length > 20000 ||
        typeof data.subject !== 'string' ||
        data.subject.length > 998 ||
        (chat.conversation.channel === 'social' &&
          !['browser', 'manual'].includes(data.socialDelivery))
      )
        return invalid();
      return db.queueConversationReply(
        {
          conversationId: id,
          body: data.body,
          subject: data.subject,
          requestId: data.requestId,
          ...(chat.conversation.channel === 'social'
            ? { socialDelivery: data.socialDelivery }
            : {}),
        },
        user.id,
      );
    }
    if (
      !validId(data.messageId) ||
      !chat.messages.some(
        (m) => m.id === data.messageId && m.direction === 'out',
      )
    )
      return invalid();
    if (data.action === 'manual-viber') {
      if (chat.conversation.channel !== 'viber') return invalid();
      const { markViberSentManually } = await import('@sonar/db/viber');
      return markViberSentManually(data.messageId, id, user.id);
    }
    const outreach = await import('@sonar/db/outreach');
    if (data.action === 'save') {
      if (
        typeof data.subject !== 'string' ||
        data.subject.length > 998 ||
        typeof data.body !== 'string' ||
        !data.body.trim() ||
        data.body.length > 20000
      )
        return invalid();
      return outreach.editOutreachDraft(
        data.messageId,
        { subject: data.subject, body: data.body },
        user.id,
        expected,
        id,
      );
    }
    if (data.action === 'send')
      return outreach.sendOutreachDraft(data.messageId, user.id, expected, id);
    if (data.action === 'approve')
      return outreach.approveOutreachDraft(
        data.messageId,
        user.id,
        expected,
        id,
      );
    if (data.action === 'skip')
      return outreach.skipOutreachMessage(data.messageId, user.id, id);
    if (data.action === 'manual')
      return outreach.markOutreachManualSent(
        data.messageId,
        user.id,
        expected,
        id,
      );
    return invalid();
  });
}
