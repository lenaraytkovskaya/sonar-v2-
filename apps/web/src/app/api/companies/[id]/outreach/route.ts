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
  const taskId = new URL(request.url).searchParams.get('taskId');
  if (taskId !== null && !validId(taskId)) return invalid();
  return emailResponse(async () => {
    if (taskId) {
      const { sonarPool } = await import('@sonar/db');
      const { rows } = await sonarPool.query(
        "select id,status,reason_uk from tasks where id=$1 and type='ai.drafts' and payload->>'companyId'=$2",
        [taskId, id],
      );
      return (
        rows[0] ?? Response.json({ error: uk.tasks.missing }, { status: 404 })
      );
    }
    const { getCompanyChat } = await import('@sonar/db/outreach');
    return getCompanyChat(id);
  });
}
export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !data) return invalid();
  return emailResponse(async () => {
    if (data.action === 'block') {
      const { blockCompany } = await import('@sonar/db/email');
      await blockCompany(id, user.id);
      return { ok: true };
    }
    const db = await import('@sonar/db/outreach');
    if (['generate', 'call'].includes(data.action)) {
      if (
        !validId(data.contactId) ||
        !validId(data.campaignId) ||
        !validId(data.requestId)
      )
        return invalid();
      const input = {
        companyId: id,
        contactId: data.contactId,
        campaignId: data.campaignId,
        requestId: data.requestId,
      };
      if (data.action === 'generate')
        return Response.json(await db.enqueueDraft(input, user.id), {
          status: 202,
        });
      if (
        typeof data.body !== 'string' ||
        !data.body.trim() ||
        data.body.length > 20000
      )
        return invalid();
      return db.logOutreachCall({ ...input, body: data.body }, user.id);
    }
    if (
      !['save', 'send', 'approve', 'manual', 'skip'].includes(data.action) ||
      !validId(data.messageId)
    )
      return invalid();
    const chat = await db.getCompanyChat(id);
    if (!chat.messages.some((message) => message.id === data.messageId))
      return invalid();
    if (data.action === 'save') {
      if (
        typeof data.subject !== 'string' ||
        data.subject.length > 998 ||
        typeof data.body !== 'string' ||
        !data.body.trim() ||
        data.body.length > 20000
      )
        return invalid();
      return db.editOutreachDraft(
        data.messageId,
        { subject: data.subject, body: data.body },
        user.id,
      );
    }
    if (data.action === 'send')
      return db.sendOutreachDraft(data.messageId, user.id);
    if (data.action === 'approve')
      return db.approveOutreachDraft(data.messageId, user.id);
    if (data.action === 'manual')
      return db.markOutreachManualSent(data.messageId, user.id);
    return db.skipOutreachMessage(data.messageId, user.id);
  });
}
