import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

type Context = { params: Promise<{ id: string; contactId: string }> };

async function ids(context: Context) {
  const { id, contactId } = await context.params;
  return validId(id) && validId(contactId) ? { id, contactId } : null;
}

export async function GET(request: Request, context: Context) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const values = await ids(context);
  if (!values) return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { getFacebookRecipientCheck } =
    await import('@sonar/db/social-recipient-check');
  const task = await getFacebookRecipientCheck(
    values.id,
    values.contactId,
    user.id,
  );
  return Response.json({ task }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const values = await ids(context);
  if (!values) return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { enqueueFacebookRecipientCheck, FacebookRecipientCheckError } =
    await import('@sonar/db/social-recipient-check');
  try {
    const task = await enqueueFacebookRecipientCheck(
      values.id,
      values.contactId,
      user.id,
    );
    return Response.json({ task }, { status: 202 });
  } catch (error) {
    if (error instanceof FacebookRecipientCheckError)
      return Response.json({ error: error.reasonUk }, { status: error.status });
    throw error;
  }
}
