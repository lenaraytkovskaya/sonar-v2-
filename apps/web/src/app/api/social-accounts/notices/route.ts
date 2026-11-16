import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const user = await apiUser(request);
  if (!user)
    return Response.json({ error: uk.unauthorized }, { status: 401, headers });
  const { listSocialSessionNotices } =
    await import('@sonar/db/social-accounts');
  const notices = (await listSocialSessionNotices(user.id)).map(
    ({ id, name, network, eventId, reasonUk }) => ({
      id,
      name,
      network,
      eventId,
      reasonUk,
    }),
  );
  return Response.json({ userId: user.id, notices }, { headers });
}
