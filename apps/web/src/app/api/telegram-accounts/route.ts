import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

export async function POST(request: Request) {
  return mutate(request, 'POST');
}
export async function PATCH(request: Request) {
  return mutate(request, 'PATCH');
}
export async function DELETE(request: Request) {
  return mutate(request, 'DELETE');
}
async function mutate(request: Request, method: string) {
  const user = await apiUser(request, true);
  const respond = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = await request.json().catch(() => null);
  const invalid = () => respond({ error: uk.ai.invalid }, 400);
  const telegram = await import('@sonar/db/telegram');
  const { EmailValidationError } = await import('@sonar/db/email');
  try {
    if (method === 'POST' && data?.action === 'start') {
      if (
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 200 ||
        typeof data.phone !== 'string' ||
        data.phone.length > 32 ||
        !Number.isSafeInteger(data.dailyLimit) ||
        data.dailyLimit < 1
      )
        return invalid();
      const result = await telegram.beginTelegramLogin(
        { name: data.name, phone: data.phone, dailyLimit: data.dailyLimit },
        user.id,
      );
      return respond({
        id: result.id,
        step: result.step,
        deliveryUk: result.deliveryUk,
      });
    }
    if (!validId(data?.id)) return invalid();
    if (method === 'POST' && data.action === 'complete') {
      if (!(
        (typeof data.code === 'string' && data.password === undefined) ||
        (typeof data.password === 'string' && data.code === undefined)
      ))
        return invalid();
      const secret = data.code ?? data.password;
      if (
        !secret.length ||
        secret.length > (data.code === undefined ? 1024 : 20)
      )
        return invalid();
      const result = await telegram.completeTelegramLogin(
        data.id,
        { code: data.code, password: data.password },
        user.id,
      );
      return respond({ id: result.id, step: result.step });
    }
    if (method === 'PATCH') {
      if (
        (data.enabled === undefined && data.dailyLimit === undefined) ||
        (data.enabled !== undefined && typeof data.enabled !== 'boolean') ||
        (data.dailyLimit !== undefined &&
          (!Number.isSafeInteger(data.dailyLimit) || data.dailyLimit < 1))
      )
        return invalid();
      return (await telegram.updateTelegramAccount(
        data.id,
        {
          ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
          ...(data.dailyLimit === undefined
            ? {}
            : { dailyLimit: data.dailyLimit }),
        },
        user.id,
      ))
        ? respond({ ok: true })
        : invalid();
    }
    if (method === 'DELETE')
      return (await telegram.logoutTelegramAccount(data.id, user.id))
        ? respond({ ok: true })
        : invalid();
    return invalid();
  } catch (error) {
    return respond(
      {
        error:
          error instanceof EmailValidationError
            ? error.reasonUk
            : uk.email.error,
      },
      error instanceof EmailValidationError ? 400 : 500,
    );
  }
}
