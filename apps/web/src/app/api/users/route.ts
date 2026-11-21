import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

const respond = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });

export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return respond({ error: uk.unauthorized }, 401);
  const db = await import('@sonar/db/user-invites');
  return respond(await db.listUsersAndInvites());
}

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = await request.json().catch(() => null);
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.email !== 'string'
  )
    return respond({ error: uk.users.invalid }, 400);
  const db = await import('@sonar/db/user-invites');
  try {
    const result = await db.createInvite(data.email, user.id);
    if ('error' in result)
      return respond(
        {
          error: result.error === 'exists' ? uk.users.exists : uk.users.invalid,
        },
        result.error === 'exists' ? 409 : 400,
      );
    return respond({ ok: true }, 201);
  } catch {
    return respond({ error: uk.users.failed }, 500);
  }
}

export async function DELETE(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = await request.json().catch(() => null);
  if (!data || !validId(data.id))
    return respond({ error: uk.users.failed }, 400);
  const db = await import('@sonar/db/user-invites');
  await db.revokeInvite(data.id, user.id);
  return respond({ ok: true });
}
