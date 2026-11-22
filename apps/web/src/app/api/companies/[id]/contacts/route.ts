import { apiUser, validId } from '@/lib/api-access';
import { manualContactSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { manualEntryResponse } from '@/lib/manual-entry-response';
function parseEdit(body: unknown) {
  if (!body || typeof body !== 'object') return null;
  const { contactId, value, note, ...rest } = body as Record<string, unknown>;
  if (
    Object.keys(rest).length ||
    typeof contactId !== 'string' ||
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2000 ||
    (note !== undefined && (typeof note !== 'string' || note.length > 2000))
  )
    return null;
  return { contactId, value: value.trim(), note: note?.trim() };
}
async function mutate(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { addManualContact, deleteContact, updateContact } =
    await import('@sonar/db/companies');
  try {
    if (request.method === 'DELETE') {
      const contactId = new URL(request.url).searchParams.get('contactId');
      if (!validId(contactId))
        return Response.json({ error: uk.ai.invalid }, { status: 400 });
      await deleteContact(id, contactId, user.id);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'PATCH') {
      const body = parseEdit(await request.json().catch(() => null));
      if (!body || !validId(body.contactId))
        return Response.json(
          { error: uk.manual.errors.invalidContact },
          { status: 400 },
        );
      const { contactId, ...input } = body;
      return Response.json(await updateContact(id, contactId, input, user.id));
    }
    const parsed = manualContactSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return Response.json(
        { error: uk.manual.errors.invalidContact },
        { status: 400 },
      );
    return Response.json(await addManualContact(id, parsed.data, user.id), {
      status: 201,
    });
  } catch (error) {
    return manualEntryResponse(error);
  }
}
export { mutate as POST, mutate as PATCH, mutate as DELETE };
