import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
import { socialNetworks } from '@/lib/social-settings';
const respond = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: Request) {
  return handle(request, 'GET');
}
export async function POST(request: Request) {
  return handle(request, 'POST');
}
export async function PATCH(request: Request) {
  return handle(request, 'PATCH');
}
async function handle(request: Request, method: string) {
  const user = await apiUser(request, method !== 'GET');
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = method === 'GET' ? null : await request.json().catch(() => null);
  const invalid = () => respond({ error: uk.ai.invalid }, 400);
  const db = await import('@sonar/db/social-accounts');
  const { EmailValidationError } = await import('@sonar/db/email');
  try {
    let queued = false;
    let inboxSync;
    if (method === 'POST' && data?.action === 'syncInbox') {
      if (
        !validId(data.id) ||
        Object.keys(data).some((key) => !['action', 'id'].includes(key))
      )
        return invalid();
      inboxSync = await db.syncSocialInbox(data.id, user.id);
      queued = true;
    } else if (method === 'POST' && data?.action === 'check') {
      if (!validId(data.id)) return invalid();
      await db.checkSocialSession(data.id, user.id);
      queued = true;
    } else if (method === 'POST') {
      if (
        !data ||
        (data.id !== undefined && !validId(data.id)) ||
        !socialNetworks.includes(data.network) ||
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 200 ||
        !Number.isSafeInteger(data.dailyLimit) ||
        data.dailyLimit < 1 ||
        !Number.isSafeInteger(data.proxyIndex) ||
        data.proxyIndex < 0 ||
        data.proxyIndex >= db.getSocialProxyCount() ||
        (data.cookiesJson !== undefined &&
          (typeof data.cookiesJson !== 'string' ||
            data.cookiesJson.length > 200000))
      )
        return invalid();
      await db.saveSocialAccount(
        {
          ...(data.id ? { id: data.id } : {}),
          name: data.name,
          network: data.network,
          dailyLimit: data.dailyLimit,
          proxyIndex: data.proxyIndex,
          ...(data.cookiesJson === undefined
            ? {}
            : { cookiesJson: data.cookiesJson }),
        },
        user.id,
      );
    } else if (method === 'PATCH') {
      if (!validId(data?.id) || typeof data.enabled !== 'boolean')
        return invalid();
      await db.updateSocialAccount(data.id, { enabled: data.enabled }, user.id);
    } else if (method !== 'GET') return invalid();
    const accounts = (await db.listSocialAccounts(user.id)).map((account) => ({
      id: account.id,
      name: account.name,
      network: account.network,
      dailyLimit: account.dailyLimit,
      sentToday: account.sentToday,
      enabled: account.enabled,
      status: account.status,
      sessionStatus: account.sessionStatus,
      reasonUk: account.reasonUk,
      checkedAt: account.checkedAt,
      nextSendAt: account.nextSendAt,
      proxyIndex: account.proxyIndex,
      ownerName: account.ownerName,
      canSyncInbox: account.canSyncInbox,
    }));
    return respond(
      { accounts, ...(inboxSync ? { inboxSync } : {}) },
      queued ? 202 : 200,
    );
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
