import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || data?.action !== 'sent')
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { markFormMessageSent } = await import('@sonar/db/forms');
    return (await markFormMessageSent(id, user.id))
      ? { ok: true }
      : Response.json({ error: uk.ai.invalid }, { status: 400 });
  });
}
