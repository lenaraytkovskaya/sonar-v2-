import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';

type Progress = {
  id: string;
  status: string;
  qr?: string;
  reasonUk?: string | null;
};
const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const publicProgress = (value: Progress) => ({
  id: value.id,
  status: value.status,
  ...(value.qr &&
  value.status === 'qr' &&
  /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.qr)
    ? { qr: value.qr }
    : {}),
  reasonUk: value.reasonUk ?? null,
});
export async function GET(request: Request) {
  return handle(request, 'GET');
}
export async function POST(request: Request) {
  return handle(request, 'POST');
}
export async function PATCH(request: Request) {
  return handle(request, 'PATCH');
}
export async function DELETE(request: Request) {
  return handle(request, 'DELETE');
}
async function handle(request: Request, method: string) {
  const user = await apiUser(request, method !== 'GET');
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data =
    method === 'GET'
      ? { id: new URL(request.url).searchParams.get('id') }
      : await request.json().catch(() => null);
  const invalid = () => respond({ error: uk.ai.invalid }, 400);
  const whatsapp = await import('@sonar/db/whatsapp');
  const { EmailValidationError } = await import('@sonar/db/email');
  try {
    let progress: Progress | undefined;
    if (method === 'POST' && data?.action === 'start') {
      if (
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 200 ||
        !Number.isSafeInteger(data.dailyLimit) ||
        data.dailyLimit < 1
      )
        return invalid();
      progress = await whatsapp.connectWhatsAppAccount(
        { name: data.name, dailyLimit: data.dailyLimit },
        user.id,
      );
    } else {
      if (!validId(data?.id)) return invalid();
      if (method === 'GET')
        progress = await whatsapp.refreshWhatsAppAccount(data.id, user.id);
      else if (method === 'POST' && data.action === 'restart')
        progress = await whatsapp.restartWhatsAppAccount(data.id, user.id);
      else if (method === 'PATCH') {
        if (
          (data.enabled === undefined && data.dailyLimit === undefined) ||
          (data.enabled !== undefined && typeof data.enabled !== 'boolean') ||
          (data.dailyLimit !== undefined &&
            (!Number.isSafeInteger(data.dailyLimit) || data.dailyLimit < 1))
        )
          return invalid();
        if (
          !(await whatsapp.updateWhatsAppAccount(
            data.id,
            {
              ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
              ...(data.dailyLimit === undefined
                ? {}
                : { dailyLimit: data.dailyLimit }),
            },
            user.id,
          ))
        )
          return invalid();
      } else if (method === 'DELETE') {
        if (!(await whatsapp.logoutWhatsAppAccount(data.id, user.id)))
          return invalid();
      } else return invalid();
    }
    const accounts = (await whatsapp.listWhatsAppAccounts()).map((account) => ({
      id: account.id,
      name: account.name,
      address: account.address,
      dailyLimit: account.dailyLimit,
      sentToday: account.sentToday,
      enabled: account.enabled,
      desiredEnabled: account.desiredEnabled,
      providerName: account.providerName,
      nextSendAt: account.nextSendAt,
      ownerName: account.ownerName,
      status: account.status,
      reasonUk: account.reasonUk,
    }));
    return respond({
      accounts,
      ...(progress ? { progress: publicProgress(progress) } : {}),
    });
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
