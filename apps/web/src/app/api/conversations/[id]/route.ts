import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
type Context = { params: Promise<{ id: string }> };
const invalid = () => Response.json({ error: uk.ai.invalid }, { status: 400 });
export async function GET(request: Request, context: Context) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id)) return invalid();
  return emailResponse(async () => {
    const taskId = new URL(request.url).searchParams.get('taskId');
    if (taskId) {
      if (!validId(taskId)) return invalid();
      const { sonarPool } = await import('@sonar/db');
      const { rows } = await sonarPool.query(
        "select id,status,reason_uk from tasks where id=$1 and type='ai.reply' and payload->>'conversationId'=$2",
        [taskId, id],
      );
      return (
        rows[0] ?? Response.json({ error: uk.tasks.missing }, { status: 404 })
      );
    }
    const { getConversationChat } = await import('@sonar/db/inbound');
    const chat = await getConversationChat(id);
    return chat.conversation
      ? chat
      : Response.json({ error: uk.tasks.missing }, { status: 404 });
  });
}
export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !data) return invalid();
  return emailResponse(async () => {
    const db = await import('@sonar/db/inbound');
    const chat = await db.getConversationChat(id);
    if (!chat.conversation) return invalid();
    if (data.action === 'read') {
      if (
        !validId(data.messageId) ||
        !chat.messages.some(
          (m) => m.id === data.messageId && m.direction === 'in',
        )
      )
        return invalid();
      await db.markConversationRead(id, data.messageId);
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
        data.subject.length > 998
      )
        return invalid();
      return db.queueConversationReply(
        {
          conversationId: id,
          body: data.body,
          subject: data.subject,
          requestId: data.requestId,
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
      );
    }
    if (data.action === 'send')
      return outreach.sendOutreachDraft(data.messageId, user.id);
    if (data.action === 'approve')
      return outreach.approveOutreachDraft(data.messageId, user.id);
    if (data.action === 'skip')
      return outreach.skipOutreachMessage(data.messageId, user.id);
    if (data.action === 'manual')
      return outreach.markOutreachManualSent(data.messageId, user.id);
    return invalid();
  });
}
