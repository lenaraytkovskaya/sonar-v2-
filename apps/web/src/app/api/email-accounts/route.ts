import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export async function PATCH(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (!validId(data?.id) || typeof data?.enabled !== 'boolean')
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { setEmailAccountEnabled } = await import('@sonar/db/email');
    return setEmailAccountEnabled(data.id, data.enabled, user.id);
  });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    typeof data?.name !== 'string' ||
    typeof data?.fromAddress !== 'string' ||
    !Number.isSafeInteger(data?.dailyLimit)
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { createEmailAccount } = await import('@sonar/db/email');
    return createEmailAccount(
      {
        name: data.name,
        fromAddress: data.fromAddress,
        dailyLimit: data.dailyLimit,
      },
      user.id,
    );
  });
}
