import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !validId(data?.companyId) || !validId(data?.contactId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const db = await import('@sonar/db/inbound');
    return Response.json(
      await db.bindViberThread(id, data.companyId, data.contactId, user.id),
    );
  });
}
