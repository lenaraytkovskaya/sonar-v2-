import { normalizePhone, type CountryCode } from './index.js';

export class WhatsAppSendError extends Error {
  public providerMessageId?: string;
  public accountRetryAfterSeconds?: number;
  constructor(
    public code: string,
    public reasonUk: string,
    public retryable = false,
    public retryAfterSeconds?: number,
    public unavailable = false,
    public sessionInactive = false,
  ) {
    super(reasonUk);
  }
}
export const whatsappError = (error: unknown): WhatsAppSendError =>
  error instanceof WhatsAppSendError
    ? error
    : new WhatsAppSendError(
        'waha_error',
        'Не вдалося виконати запит WhatsApp.',
      );

/**
 * WAHA engines answer sendText differently: WEBJS gives {id:{_serialized}}, NOWEB/GOWS give
 * the raw message {key:{id}} (a real message was delivered while the old check only took a
 * string id).
 */
export function whatsappMessageId(
  sent: Record<string, unknown>,
): string | null {
  const id = sent.id as unknown;
  if (typeof id === 'string' && id) return id;
  if (id && typeof id === 'object') {
    const serialized = (id as { _serialized?: unknown; id?: unknown })
      ._serialized;
    if (typeof serialized === 'string' && serialized) return serialized;
    const inner = (id as { id?: unknown }).id;
    if (typeof inner === 'string' && inner) return inner;
  }
  const key = (sent.key ??
    (sent._data as { key?: unknown } | undefined)?.key) as
    { id?: unknown } | undefined;
  if (typeof key?.id === 'string' && key.id) return key.id;
  return null;
}
export function normalizeWhatsAppRecipient(
  raw: string,
  defaultCountry?: CountryCode,
): string | null {
  let value = raw.trim();
  if (/^whatsapp:lid:[1-9]\d*$/.test(value)) return value;
  if (/^(?:https?:\/\/)?wa\.me\//i.test(value)) {
    try {
      const url = new URL(/^https?:/i.test(value) ? value : `https://${value}`);
      if (
        url.hostname.toLowerCase() !== 'wa.me' ||
        !/^\/\d+\/?$/.test(url.pathname)
      )
        return null;
      value = `+${url.pathname.replaceAll('/', '')}`;
    } catch {
      return null;
    }
  }
  if (!value.startsWith('+') && !defaultCountry) {
    if (!/^[1-9]\d{6,14}$/.test(value)) return null;
    value = `+${value}`;
  }
  return normalizePhone(value, defaultCountry!);
}
export type WhatsAppSession = {
  status: 'WORKING' | 'SCAN_QR_CODE' | 'STARTING' | 'STOPPED' | 'FAILED';
  phone: string | null;
  name?: string;
};
export type WhatsAppWebhookDiagnostic = {
  scope: 'session_config_only';
  webhookReachability: 'not_checked';
  providerReachability: 'reachable' | 'unreachable' | 'not_checked';
  providerError:
    | 'none'
    | 'not_configured'
    | 'unauthorized'
    | 'session_missing'
    | 'rate_limited'
    | 'invalid_response'
    | 'provider_error';
  sessionState:
    | WhatsAppSession['status']
    | 'PASSKEY_REQUIRED'
    | 'PASSKEY_CONFIRMATION_REQUIRED'
    | 'unknown'
    | 'missing';
  expectedUrlConfigured: boolean | 'unknown';
  messageEventConfigured: boolean | 'unknown';
  apiKeyMatches: boolean | 'unknown';
};
export type WhatsAppSendRequest = {
  accountId: string;
  to: string;
  body: string;
  idempotencyKey: string;
  defaultCountry?: CountryCode;
};
export function createWhatsAppAdapter(
  config: { baseUrl?: string; apiKey?: string } = {},
  network: typeof fetch = (...args) => fetch(...args),
) {
  const webhookUrl = 'http://web:3000/api/webhooks/waha';
  async function request(
    path: string,
    method = 'GET',
    body?: object,
    sending = false,
  ): Promise<Record<string, unknown>> {
    const apiKey = config.apiKey ?? process.env.WAHA_API_KEY;
    if (!apiKey)
      throw new WhatsAppSendError(
        'waha_config',
        'Не налаштовано WAHA_API_KEY на сервері.',
      );
    let response: Response;
    try {
      response = await network(
        `${config.baseUrl ?? process.env.WAHA_URL ?? 'http://waha:3000'}${path}`,
        {
          method,
          headers: {
            'X-Api-Key': apiKey,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new WhatsAppSendError(
        sending ? 'send_ambiguous' : 'waha_unreachable',
        sending
          ? 'Результат надсилання WhatsApp невідомий. Перевірте чат перед повтором.'
          : 'Сервіс WhatsApp недоступний. Повторіть спробу.',
        !sending,
      );
    }
    let data: Record<string, unknown> = {};
    try {
      const text = await response.text();
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Invalid provider response');
        data = parsed as Record<string, unknown>;
      }
    } catch {
      if (response.ok)
        throw new WhatsAppSendError(
          sending ? 'send_ambiguous' : 'waha_response',
          sending
            ? 'Результат надсилання WhatsApp невідомий. Перевірте чат перед повтором.'
            : 'Сервіс WhatsApp повернув некоректну відповідь.',
          !sending,
        );
    }
    if (response.ok) return data;
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry)
          : retry
            ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
            : undefined;
      throw new WhatsAppSendError(
        'rate_limit',
        'WhatsApp обмежив запити. Надсилання відкладено.',
        true,
        seconds && Number.isFinite(seconds) ? Math.max(1, seconds) : undefined,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new WhatsAppSendError(
        'waha_auth',
        'Перевірте ключ доступу WAHA на сервері.',
      );
    if (response.status === 404)
      throw new WhatsAppSendError(
        'session_missing',
        'Сесію WhatsApp не знайдено. Підключіть акаунт.',
        false,
        undefined,
        false,
        true,
      );
    if (
      response.status === 422 &&
      /session|WORKING|SCAN_QR|STOPPED/i.test(JSON.stringify(data))
    )
      throw new WhatsAppSendError(
        'session_inactive',
        'Сесія WhatsApp не працює. Підключіть акаунт повторно.',
        false,
        undefined,
        false,
        true,
      );
    throw new WhatsAppSendError(
      'waha_error',
      'Не вдалося виконати запит WhatsApp. Повторіть спробу.',
      response.status >= 500,
    );
  }
  async function getSession(): Promise<WhatsAppSession | null> {
    let data;
    try {
      data = await request('/api/sessions/default');
    } catch (error) {
      if (
        error instanceof WhatsAppSendError &&
        error.code === 'session_missing'
      )
        return null;
      throw error;
    }
    if (
      !['WORKING', 'SCAN_QR_CODE', 'STARTING', 'STOPPED', 'FAILED'].includes(
        String(data.status),
      )
    )
      throw new WhatsAppSendError(
        'waha_response',
        'Невідомий стан сесії WhatsApp.',
      );
    const me = data.me as { id?: string; pushName?: string } | null;
    const digits = me?.id?.split('@')[0]?.split(':')[0];
    return {
      status: data.status as WhatsAppSession['status'],
      phone: digits ? normalizeWhatsAppRecipient(`+${digits}`) : null,
      ...(typeof me?.pushName === 'string' ? { name: me.pushName } : {}),
    };
  }
  function webhookConfig() {
    return {
      webhooks: [
        {
          url: webhookUrl,
          events: ['message'],
          customHeaders: [
            {
              name: 'X-Api-Key',
              value: config.apiKey ?? process.env.WAHA_API_KEY,
            },
          ],
        },
      ],
    };
  }
  async function configureWebhook() {
    await request('/api/sessions/default', 'PUT', {
      name: 'default',
      config: webhookConfig(),
    });
  }
  async function createSession() {
    await request('/api/sessions', 'POST', {
      name: 'default',
      start: true,
      config: webhookConfig(),
    });
    return getSession();
  }
  return {
    getSession,
    async diagnoseWebhook(): Promise<WhatsAppWebhookDiagnostic> {
      const result: WhatsAppWebhookDiagnostic = {
        // Global env webhooks are not included in GET session config (WAHA docs).
        scope: 'session_config_only',
        webhookReachability: 'not_checked',
        providerReachability: 'not_checked',
        providerError: 'none',
        sessionState: 'unknown',
        expectedUrlConfigured: 'unknown',
        messageEventConfigured: 'unknown',
        apiKeyMatches: 'unknown',
      };
      try {
        const data = await request('/api/sessions/default');
        result.providerReachability = 'reachable';
        const states = [
          'WORKING',
          'SCAN_QR_CODE',
          'STARTING',
          'STOPPED',
          'FAILED',
          'PASSKEY_REQUIRED',
          'PASSKEY_CONFIRMATION_REQUIRED',
        ];
        if (typeof data.status !== 'string' || !states.includes(data.status))
          throw new WhatsAppSendError('waha_response', '');
        result.sessionState =
          data.status as WhatsAppWebhookDiagnostic['sessionState'];
        const object = (value: unknown): value is Record<string, unknown> =>
          !!value && typeof value === 'object' && !Array.isArray(value);
        if (data.config != null && !object(data.config))
          throw new WhatsAppSendError('waha_response', '');
        const hooks = (data.config as Record<string, unknown> | null)?.webhooks;
        if (hooks != null && !Array.isArray(hooks))
          throw new WhatsAppSendError('waha_response', '');
        const expected = (hooks ?? []).filter(
          (hook: unknown) => object(hook) && hook.url === webhookUrl,
        ) as Record<string, unknown>[];
        const message = expected.filter(
          (hook) =>
            Array.isArray(hook.events) &&
            (hook.events.includes('message') || hook.events.includes('*')),
        );
        result.expectedUrlConfigured = expected.length > 0;
        result.messageEventConfigured = message.length > 0;
        const key = config.apiKey ?? process.env.WAHA_API_KEY;
        result.apiKeyMatches = message.some((hook) => {
          const headers = hook.customHeaders;
          if (!Array.isArray(headers)) return false;
          const keys = headers.filter(
            (header: unknown) =>
              object(header) &&
              typeof header.name === 'string' &&
              header.name.toLowerCase() === 'x-api-key',
          );
          // Conflicting duplicate headers cannot be considered a match.
          return (
            keys.length > 0 && keys.every((header) => header.value === key)
          );
        });
      } catch (error) {
        const code = whatsappError(error).code;
        result.providerReachability =
          code === 'waha_config'
            ? 'not_checked'
            : code === 'waha_unreachable'
              ? 'unreachable'
              : 'reachable';
        result.providerError =
          code === 'waha_config'
            ? 'not_configured'
            : code === 'waha_auth'
              ? 'unauthorized'
              : code === 'session_missing'
                ? 'session_missing'
                : code === 'rate_limit'
                  ? 'rate_limited'
                  : code === 'waha_response'
                    ? 'invalid_response'
                    : 'provider_error';
        if (code === 'session_missing') result.sessionState = 'missing';
      }
      return result;
    },
    async phoneByLid(lid: string): Promise<string | null> {
      if (!/^[1-9]\d*@lid$/.test(lid)) return null;
      const data = await request(
        `/api/default/lids/${encodeURIComponent(lid)}`,
      );
      return typeof data.pn === 'string' && /^[1-9]\d*@c\.us$/.test(data.pn)
        ? normalizeWhatsAppRecipient(`+${data.pn.split('@')[0]}`)
        : null;
    },
    async start() {
      const session = await getSession();
      if (!session) return createSession();
      await configureWebhook();
      if (session.status === 'STOPPED')
        await request('/api/sessions/default/start', 'POST');
      else if (session.status === 'FAILED')
        await request('/api/sessions/default/restart', 'POST');
      return getSession();
    },
    async restart() {
      if (!(await getSession())) return createSession();
      await configureWebhook();
      await request('/api/sessions/default/restart', 'POST');
      return getSession();
    },
    async logout() {
      if (!(await getSession())) return;
      await request('/api/sessions/default/stop', 'POST');
      await request('/api/sessions/default/logout', 'POST');
    },
    async getQr() {
      const data = await request('/api/default/auth/qr?format=image');
      if (
        data.mimetype !== 'image/png' ||
        typeof data.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data)
      )
        throw new WhatsAppSendError(
          'waha_qr',
          'Не вдалося отримати QR-код WhatsApp. Оновіть стан.',
        );
      return `data:image/png;base64,${data.data}`;
    },
    async send(input: WhatsAppSendRequest) {
      const lid = /^whatsapp:lid:([1-9]\d*)$/.exec(input.to)?.[1];
      const phone = normalizeWhatsAppRecipient(input.to, input.defaultCountry);
      if (!phone || !input.body.trim() || !input.idempotencyKey)
        throw new WhatsAppSendError(
          'invalid_recipient',
          'Вкажіть міжнародний номер WhatsApp та текст повідомлення.',
        );
      if ((await getSession())?.status !== 'WORKING')
        throw new WhatsAppSendError(
          'session_inactive',
          'Сесія WhatsApp не працює. Підключіть акаунт повторно.',
          false,
          undefined,
          false,
          true,
        );
      const contact = lid
        ? { numberExists: true, chatId: `${lid}@lid` }
        : await request(
            `/api/contacts/check-exists?${new URLSearchParams({ phone: phone.slice(1), session: 'default' })}`,
          );
      if (contact.numberExists === false)
        throw new WhatsAppSendError(
          'unavailable',
          'WhatsApp недоступний: номер не зареєстровано.',
          false,
          undefined,
          true,
        );
      if (
        contact.numberExists !== true ||
        typeof contact.chatId !== 'string' ||
        !/^\d+@(c\.us|lid)$/.test(contact.chatId)
      )
        throw new WhatsAppSendError(
          'waha_response',
          'Не вдалося перевірити номер WhatsApp.',
          true,
        );
      // WAHA Core does not expose provider idempotency; the DB must guard attempts.
      const sent = await request(
        '/api/sendText',
        'POST',
        { session: 'default', chatId: contact.chatId, text: input.body },
        true,
      );
      const messageId = whatsappMessageId(sent);
      if (!messageId)
        throw new WhatsAppSendError(
          'send_ambiguous',
          'Результат надсилання WhatsApp невідомий. Перевірте чат перед повтором.',
        );
      return { messageId };
    },
  };
}
export const whatsappAdapter = createWhatsAppAdapter();
