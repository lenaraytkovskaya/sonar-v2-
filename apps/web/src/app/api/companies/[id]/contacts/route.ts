import { apiUser, validId } from '@/lib/api-access';
import { manualContactSchema } from '@sonar/core';
import { uk } from '@/i18n/uk';
import { manualEntryResponse } from '@/lib/manual-entry-response';
async function mutate(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { addManualContact, deleteManualContact } =
    await import('@sonar/db/companies');
  try {
    if (request.method === 'DELETE') {
      const contactId = new URL(request.url).searchParams.get('contactId');
      if (!validId(contactId))
        return Response.json({ error: uk.ai.invalid }, { status: 400 });
      await deleteManualContact(id, contactId, user.id);
      return new Response(null, { status: 204 });
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
export { mutate as POST, mutate as DELETE };
