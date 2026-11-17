import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !validId(data?.contactId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { retryWhatsAppContact } = await import('@sonar/db/email');
  const updated = await retryWhatsAppContact(id, data.contactId, user.id);
  return updated
    ? Response.json({ ok: true })
    : Response.json({ error: uk.ai.invalid }, { status: 404 });
}
