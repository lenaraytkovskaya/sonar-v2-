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
  const response = await emailResponse(async () => {
    const { getFormReplyMatch } = await import('@sonar/db/form-replies');
    return Response.json(await getFormReplyMatch(id));
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (
    !validId(id) ||
    !['bind', 'unbind', 'reject'].includes(data?.action) ||
    (data.action === 'bind' && !validId(data.companyId))
  )
    return invalid();
  return emailResponse(async () => {
    const db = await import('@sonar/db/form-replies');
    if (data.action === 'bind') {
      const match = await db.getFormReplyMatch(id);
      if (
        match?.state !== 'suggested' ||
        match.suggestedCompanyId !== data.companyId
      )
        return invalid();
      await db.bindFormReplyConversation({
        conversationId: id,
        companyId: data.companyId,
        actorId: user.id,
        method: 'manual',
        reasonUk: match.reasonUk,
        confidence: match.confidence,
        formMessageId: match.formMessageId,
      });
    } else if (data.action === 'unbind')
      await db.unbindFormReplyConversation(id, user.id);
    else await db.rejectFormReplySuggestion(id, user.id);
    return Response.json(await db.getFormReplyMatch(id));
  });
}
