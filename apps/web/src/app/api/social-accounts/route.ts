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
export async function DELETE(request: Request) {
  return handle(request, 'DELETE');
}
async function handle(request: Request, method: string) {
  const user = await apiUser(request, method !== 'GET');
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = method === 'GET' ? null : await request.json().catch(() => null);
  const invalid = () => respond({ error: uk.ai.invalid }, 400);
  const credentialAction = ['credentials', 'login', 'loginCode'].includes(
    data?.action,
  );
  const db = await import('@sonar/db/social-accounts');
  const { EmailValidationError } = await import('@sonar/db/email');
  try {
    let queued = false;
    let inboxSync;
    if (method === 'DELETE') {
      if (
        data?.action !== 'remove' ||
        !validId(data.id) ||
        Object.keys(data).some((key) => !['action', 'id'].includes(key))
      )
        return invalid();
      await db.removeSocialAccount(data.id, user.id);
    } else if (method === 'POST' && data?.action === 'createWithCredentials') {
      const totpSecret =
        typeof data.totpSecret === 'string'
          ? data.totpSecret
              .replace(/[\s-]/g, '')
              .toUpperCase()
              .replace(/=+$/, '')
          : data.totpSecret;
      if (
        Object.keys(data).some(
          (key) =>
            ![
              'action',
              'name',
              'network',
              'dailyLimit',
              'proxyIndex',
              'ownProxy',
              'keepaliveEnabled',
              'login',
              'password',
              'totpSecret',
            ].includes(key),
        ) ||
        !socialNetworks.includes(data.network) ||
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 200 ||
        !Number.isSafeInteger(data.dailyLimit) ||
        data.dailyLimit < 1 ||
        typeof data.login !== 'string' ||
        !data.login.trim() ||
        data.login.length > 320 ||
        typeof data.password !== 'string' ||
        !data.password ||
        data.password.length > 1024 ||
        (totpSecret !== undefined &&
          totpSecret !== null &&
          (typeof totpSecret !== 'string' ||
            !/^[A-Z2-7]{16,256}$/.test(totpSecret))) ||
        (data.proxyIndex !== undefined &&
          (!Number.isSafeInteger(data.proxyIndex) ||
            data.proxyIndex < 0 ||
            data.proxyIndex >= db.getSocialProxyCount())) ||
        (data.ownProxy !== undefined &&
          data.ownProxy !== null &&
          (typeof data.ownProxy !== 'string' || data.ownProxy.length > 4000)) ||
        (data.keepaliveEnabled !== undefined &&
          typeof data.keepaliveEnabled !== 'boolean')
      )
        return invalid();
      await db.createSocialAccountWithCredentials(
        {
          name: data.name,
          network: data.network,
          dailyLimit: data.dailyLimit,
          ...(data.proxyIndex === undefined
            ? {}
            : { proxyIndex: data.proxyIndex }),
          ...(data.ownProxy === undefined ? {} : { ownProxy: data.ownProxy }),
          ...(data.keepaliveEnabled === undefined
            ? {}
            : { keepaliveEnabled: data.keepaliveEnabled }),
          login: data.login,
          password: data.password,
          ...(totpSecret === undefined || totpSecret === null
            ? {}
            : { totpSecret }),
        },
        user.id,
      );
      queued = true;
    } else if (method === 'POST' && credentialAction) {
      const allowed =
        data.action === 'credentials'
          ? ['action', 'id', 'login', 'password', 'totpSecret']
          : data.action === 'loginCode'
            ? ['action', 'id', 'code']
            : ['action', 'id'];
      if (
        !validId(data.id) ||
        Object.keys(data).some((key) => !allowed.includes(key))
      )
        return invalid();
      if (data.action === 'credentials') {
        const totpSecret =
          typeof data.totpSecret === 'string'
            ? data.totpSecret
                .replace(/[\s-]/g, '')
                .toUpperCase()
                .replace(/=+$/, '')
            : data.totpSecret;
        if (
          typeof data.login !== 'string' ||
          !data.login.trim() ||
          data.login.length > 320 ||
          typeof data.password !== 'string' ||
          !data.password ||
          data.password.length > 1024 ||
          (totpSecret !== undefined &&
            totpSecret !== null &&
            (typeof totpSecret !== 'string' ||
              !/^[A-Z2-7]{16,256}$/.test(totpSecret)))
        )
          return invalid();
        const result = await db.saveSocialCredentials(
          data.id,
          {
            login: data.login,
            password: data.password,
            ...(totpSecret === undefined ? {} : { totpSecret }),
          },
          user.id,
        );
        queued = !!result.id;
      } else if (data.action === 'loginCode') {
        if (typeof data.code !== 'string' || !/^[0-9]{4,10}$/.test(data.code))
          return invalid();
        await db.submitSocialLoginCode(data.id, data.code, user.id);
      } else await db.queueSocialCredentialLogin(data.id, user.id);
      if (data.action !== 'credentials') queued = true;
    } else if (method === 'POST' && data?.action === 'inboxPolling') {
      if (
        !validId(data.id) ||
        typeof data.enabled !== 'boolean' ||
        Object.keys(data).some(
          (key) => !['action', 'id', 'enabled'].includes(key),
        )
      )
        return invalid();
      await db.setSocialInboxPolling(data.id, data.enabled, user.id);
    } else if (method === 'POST' && data?.action === 'updateDevice') {
      if (
        !validId(data.id) ||
        !data.ownerBrowser ||
        typeof data.ownerBrowser !== 'object' ||
        Array.isArray(data.ownerBrowser) ||
        JSON.stringify(data.ownerBrowser).length > 10_000 ||
        Object.keys(data).some(
          (key) => !['action', 'id', 'ownerBrowser'].includes(key),
        )
      )
        return invalid();
      await db.updateSocialDevice(data.id, data.ownerBrowser, user.id);
    } else if (method === 'POST' && data?.action === 'syncInbox') {
      if (
        !validId(data.id) ||
        Object.keys(data).some((key) => !['action', 'id'].includes(key))
      )
        return invalid();
      inboxSync = await db.syncSocialInbox(data.id, user.id);
      queued = true;
    } else if (method === 'POST' && data?.action === 'check') {
      if (
        !validId(data.id) ||
        Object.keys(data).some((key) => !['action', 'id'].includes(key))
      )
        return invalid();
      await db.checkSocialSession(data.id, user.id);
      queued = true;
    } else if (method === 'POST') {
      if (
        !data ||
        Object.keys(data).some(
          (key) =>
            ![
              'id',
              'name',
              'network',
              'dailyLimit',
              'proxyIndex',
              'ownProxy',
              'keepaliveEnabled',
              'storageStateJson',
              'cookiesJson',
              'ownerBrowser',
            ].includes(key),
        ) ||
        (data.id !== undefined && !validId(data.id)) ||
        !socialNetworks.includes(data.network) ||
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        data.name.length > 200 ||
        !Number.isSafeInteger(data.dailyLimit) ||
        data.dailyLimit < 1 ||
        (data.proxyIndex !== undefined &&
          (!Number.isSafeInteger(data.proxyIndex) ||
            data.proxyIndex < 0 ||
            data.proxyIndex >= db.getSocialProxyCount())) ||
        (data.ownProxy !== undefined &&
          data.ownProxy !== null &&
          (typeof data.ownProxy !== 'string' || data.ownProxy.length > 4000)) ||
        (data.keepaliveEnabled !== undefined &&
          typeof data.keepaliveEnabled !== 'boolean') ||
        (data.storageStateJson !== undefined &&
          (typeof data.storageStateJson !== 'string' ||
            data.storageStateJson.length > 200000)) ||
        (data.cookiesJson !== undefined &&
          (typeof data.cookiesJson !== 'string' ||
            data.cookiesJson.length > 200000)) ||
        (data.ownerBrowser !== undefined &&
          (!data.ownerBrowser ||
            typeof data.ownerBrowser !== 'object' ||
            Array.isArray(data.ownerBrowser) ||
            JSON.stringify(data.ownerBrowser).length > 10_000))
      )
        return invalid();
      await db.saveSocialAccount(
        {
          ...(data.id ? { id: data.id } : {}),
          name: data.name,
          network: data.network,
          dailyLimit: data.dailyLimit,
          ...(data.proxyIndex === undefined
            ? {}
            : { proxyIndex: data.proxyIndex }),
          ...(data.ownProxy === undefined ? {} : { ownProxy: data.ownProxy }),
          ...(data.keepaliveEnabled === undefined
            ? {}
            : { keepaliveEnabled: data.keepaliveEnabled }),
          ...(data.storageStateJson === undefined
            ? {}
            : { storageStateJson: data.storageStateJson }),
          ...(data.cookiesJson === undefined
            ? {}
            : { cookiesJson: data.cookiesJson }),
          ...(data.ownerBrowser === undefined
            ? {}
            : { ownerBrowser: data.ownerBrowser }),
        },
        user.id,
      );
    } else if (method === 'PATCH') {
      if (
        !validId(data?.id) ||
        typeof data.enabled !== 'boolean' ||
        Object.keys(data).some((key) => !['id', 'enabled'].includes(key))
      )
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
      hasOwnProxy: account.hasOwnProxy,
      keepaliveEnabled: account.keepaliveEnabled,
      device: account.device,
      deviceSource: account.deviceSource,
      proxyPublicIp: account.proxyPublicIp,
      proxyPublicIpCheckedAt: account.proxyPublicIpCheckedAt,
      sessionLostEventId: account.sessionLostEventId,
      sessionLostReasonUk: account.sessionLostReasonUk,
      ownerName: account.ownerName,
      ownsAccount: account.ownsAccount,
      canSyncInbox: account.canSyncInbox,
      inboxPollingEnabled: account.inboxPollingEnabled,
      inboxSyncComplete: account.inboxSyncComplete,
      inboxSyncCreated: account.inboxSyncCreated,
      inboxSyncCheckedAt: account.inboxSyncCheckedAt,
      inboxSyncErrorUk: account.inboxSyncErrorUk,
      failureShotKinds: account.failureShotKinds,
      hasCredentials: account.hasCredentials,
      hasTotpSecret: account.hasTotpSecret,
      loginBlocked: account.loginBlocked,
      loginChallengeKind: account.loginChallengeKind,
      loginChallengeExpiresAt: account.loginChallengeExpiresAt,
    }));
    return respond(
      { accounts, ...(inboxSync ? { inboxSync } : {}) },
      queued ? 202 : 200,
    );
  } catch (error) {
    return respond(
      {
        // Credential errors stay redacted; only the fixed daily-limit reason is shown.
        error:
          error instanceof EmailValidationError &&
          (!credentialAction ||
            (error as { code?: string }).code === 'social_login_daily_limit')
            ? error.reasonUk
            : uk.email.error,
      },
      error instanceof EmailValidationError ? 400 : 500,
    );
  }
}
