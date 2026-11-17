import { apiUser } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  const keys = [
    'name',
    'email',
    'phone',
    'whatsapp',
    'telegram',
    'website',
  ] as const;
  if (
    !data ||
    !Number.isInteger(data.dailyLimit) ||
    data.dailyLimit < 1 ||
    data.dailyLimit > 100000 ||
    !keys.every(
      (key) => typeof data[key] === 'string' && data[key].length <= 500,
    )
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { saveContactDetails } = await import('@sonar/db/forms');
    await saveContactDetails(
      Object.fromEntries(keys.map((key) => [key, data[key]])) as Record<
        (typeof keys)[number],
        string
      >,
      user.id,
      data.dailyLimit,
    );
    return { ok: true };
  });
}
