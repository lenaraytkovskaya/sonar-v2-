import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    !data ||
    !['name', 'fromAddress', 'senderName', 'senderPhone'].every(
      (key) => typeof data[key] === 'string',
    ) ||
    !Number.isSafeInteger(data.dailyLimit) ||
    (data.id != null && !validId(data.id))
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { createFormAccount, updateFormAccount } =
      await import('@sonar/db/email');
    const input = {
      name: data.name,
      fromAddress: data.fromAddress,
      senderName: data.senderName,
      senderPhone: data.senderPhone,
      dailyLimit: data.dailyLimit,
    };
    if (!data.id) return createFormAccount(input, user.id);
    return (await updateFormAccount(data.id, input, user.id))
      ? { ok: true }
      : Response.json({ error: uk.ai.invalid }, { status: 400 });
  });
}
