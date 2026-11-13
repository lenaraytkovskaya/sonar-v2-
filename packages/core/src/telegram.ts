import { createHash } from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { computeCheck } from 'telegram/Password.js';
export {
  encryptTelegramSession,
  decryptTelegramSession,
} from './telegram-crypto.js';

/** Tells the person where Telegram actually delivered the login code. */
export function codeDelivery(type: {
  className?: string;
  emailPattern?: string;
}) {
  switch (type.className) {
    case 'auth.SentCodeTypeApp':
      return 'Код надіслано в застосунок Telegram (чат «Telegram» із синьою галочкою) на пристрої, де вже виконано вхід із цим номером.';
    case 'auth.SentCodeTypeSms':
    case 'auth.SentCodeTypeSmsWord':
    case 'auth.SentCodeTypeSmsPhrase':
    case 'auth.SentCodeTypeFirebaseSms':
      return 'Код надіслано SMS на цей номер.';
    case 'auth.SentCodeTypeFragmentSms':
      return 'Код надіслано через Fragment (номер куплено на Fragment).';
    case 'auth.SentCodeTypeEmailCode':
      return `Код надіслано на пошту для входу${type.emailPattern ? ' ' + type.emailPattern : ''}.`;
    case 'auth.SentCodeTypeSetUpEmailRequired':
      return 'Telegram не надсилає код: спершу потрібна пошта для входу. Відкрийте Telegram → Налаштування → Конфіденційність → Пошта для входу, додайте її і підключіть знову.';
    case 'auth.SentCodeTypeCall':
    case 'auth.SentCodeTypeFlashCall':
    case 'auth.SentCodeTypeMissedCall':
      return 'Telegram зателефонує на цей номер: код — у дзвінку або в останніх цифрах номера, що телефонує.';
    default:
      return `Telegram надіслав код способом ${type.className ?? 'невідомо'}.`;
  }
}
export class TelegramSendError extends Error {
  public providerMessageId?: string;
  public accountRetryAfterSeconds?: number;
  constructor(
    public code: string,
    public reasonUk: string,
    public retryable = false,
    public retryAfterSeconds?: number,
    public unavailable = false,
  ) {
    super(reasonUk);
  }
}
export function telegramError(error: unknown): TelegramSendError {
  if (error instanceof TelegramSendError) return error;
  const value = error as {
    errorMessage?: string;
    message?: string;
    seconds?: number;
  } | null;
  const code = `${value?.errorMessage ?? ''} ${value?.message ?? ''}`;
  const wait = /(?:FLOOD|SLOWMODE)_WAIT(?:_(\d+))?/.exec(code);
  if (wait || (code.includes('FLOOD') && Number.isFinite(value?.seconds))) {
    const seconds = Math.max(1, value?.seconds ?? (Number(wait?.[1]) || 60));
    return new TelegramSendError(
      'flood_wait',
      `Telegram обмежив запити. Повторіть через ${seconds} с.`,
      true,
      seconds,
    );
  }
  if (/PEER_FLOOD/.test(code))
    return new TelegramSendError(
      'peer_flood',
      'Telegram недоступний: акаунту обмежено надсилання цьому одержувачу.',
      false,
      undefined,
      true,
    );
  if (/PHONE_NUMBER_BANNED/.test(code))
    return new TelegramSendError(
      'phone_banned',
      'Telegram заблокував номер акаунта.',
    );
  if (
    /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED_BAN/.test(code)
  )
    return new TelegramSendError(
      'session_expired',
      'Сесія Telegram недійсна. Підключіть акаунт повторно.',
    );
  if (
    /USER_PRIVACY_RESTRICTED|USER_IS_BLOCKED|YOU_BLOCKED_USER|USER_DEACTIVATED|INPUT_USER_DEACTIVATED|USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PHONE_NOT_OCCUPIED|USER_NOT_FOUND|No user has "[^"]+" as username|Cannot find any entity corresponding to/.test(
      code,
    )
  )
    return new TelegramSendError(
      'unavailable',
      'Telegram недоступний: приватність, обмеження або одержувача не знайдено.',
      false,
      undefined,
      true,
    );
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY/.test(code))
    return new TelegramSendError(
      'invalid_code',
      'Код Telegram неправильний або прострочений. Запросіть новий код.',
    );
  if (/PASSWORD_HASH_INVALID/.test(code))
    return new TelegramSendError(
      'invalid_password',
      'Неправильний пароль двофакторної автентифікації Telegram.',
    );
  if (/PHONE_NUMBER_INVALID/.test(code))
    return new TelegramSendError(
      'invalid_phone',
      'Вкажіть правильний номер телефону у форматі E.164.',
    );
  return new TelegramSendError(
    'telegram_error',
    'Не вдалося виконати запит Telegram. Повторіть спробу з тим самим ключем.',
    true,
  );
}
export function normalizeTelegramRecipient(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^https?:\/\/(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)\/?$/i, '@$1');
  if (/^\+[1-9]\d{6,14}$/.test(value)) return value;
  const name = value.replace(/^@/, '');
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(name)
    ? `@${name.toLowerCase()}`
    : null;
}
export function telegramRandomId(key: string): ReturnType<typeof returnBigInt> {
  if (!key)
    throw new TelegramSendError(
      'idempotency_key',
      'Відсутній ключ повторного надсилання Telegram.',
    );
  return returnBigInt(
    createHash('sha256').update(`telegram:${key}`).digest().readBigInt64LE(),
  );
}
export type TelegramConnection = Pick<
  TelegramClient,
  'connect' | 'invoke' | 'getInputEntity' | 'destroy'
> & {
  session: { save(): string };
  switchDC?: (dc: number) => Promise<unknown>;
};
type Credentials = { apiId: number; apiHash: string };
type DataCenter = { id: number; ip: string; port: number };
export type TelegramClientFactory = (
  session: string,
  credentials: Credentials,
  dc?: DataCenter,
) => TelegramConnection;
function gramClient(
  session: string,
  credentials: Credentials,
  dc?: DataCenter,
): TelegramConnection {
  const saved = new StringSession(session);
  if (dc) saved.setDC(dc.id, dc.ip, dc.port);
  const client = new TelegramClient(
    saved,
    credentials.apiId,
    credentials.apiHash,
    {
      baseLogger: new Logger(LogLevel.NONE),
      floodSleepThreshold: 0,
      requestRetries: 2,
      connectionRetries: 2,
    },
  );
  // GramJS has no receiveUpdates option; suppress server updates on every RPC,
  // including internal entity resolution and its periodic GetState request.
  const invoke = client.invoke.bind(client);
  client.invoke = <R extends Api.AnyRequest>(
    request: R,
    dcId?: number,
  ): Promise<R['__response']> =>
    invoke(
      request instanceof Api.InvokeWithoutUpdates
        ? request
        : new Api.InvokeWithoutUpdates({ query: request }),
      dcId,
    ) as Promise<R['__response']>;
  client.onError = async () => {};
  return {
    connect: () => client.connect(),
    invoke: client.invoke.bind(client),
    getInputEntity: client.getInputEntity.bind(client),
    destroy: () => client.destroy(),
    switchDC: (dc: number) => client._switchDC(dc),
    session: saved,
  };
}
export type TelegramSendRequest = {
  accountId: string;
  session: string;
  to: string;
  body: string;
  idempotencyKey: string;
};
export function createTelegramAdapter(
  config: {
    apiId?: string | number;
    apiHash?: string;
    timeoutMs?: number;
  } = {},
  factory: TelegramClientFactory = gramClient,
) {
  const temporaryTimeoutMs = config.timeoutMs ?? 20000;
  const clients = new Map<string, Promise<TelegramConnection>>();
  function credentials(): Credentials {
    const apiId = Number(config.apiId ?? process.env.TELEGRAM_API_ID);
    const apiHash = config.apiHash ?? process.env.TELEGRAM_API_HASH;
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash)
      throw new TelegramSendError(
        'telegram_config',
        'Не налаштовано TELEGRAM_API_ID або TELEGRAM_API_HASH.',
      );
    return { apiId, apiHash };
  }
  async function temporary<T>(
    session: string,
    run: (client: TelegramConnection, auth: Credentials) => Promise<T>,
  ): Promise<T> {
    let client: TelegramConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const auth = credentials();
      client = factory(session, auth);
      const connected = client;
      // A login step must never hang: callers hold database resources while they wait.
      return await Promise.race([
        (async () => {
          await connected.connect();
          return run(connected, auth);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TelegramSendError(
                  'telegram_timeout',
                  'Telegram не відповів вчасно. Повторіть спробу.',
                  true,
                ),
              ),
            temporaryTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      throw telegramError(error);
    } finally {
      clearTimeout(timer);
      // GramJS destroy can wait on its update loop after a login; do not block on it.
      const closing = client?.destroy().catch(() => {});
      await Promise.race([
        closing,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
  }
  async function close(accountId: string) {
    const pending = clients.get(accountId);
    clients.delete(accountId);
    if (pending)
      await pending.then((client) => client.destroy()).catch(() => {});
  }
  return {
    startLogin(phone: string) {
      if (!/^\+[1-9]\d{6,14}$/.test(phone))
        throw new TelegramSendError(
          'invalid_phone',
          'Вкажіть правильний номер телефону у форматі E.164.',
        );
      return temporary('', async (client, auth) => {
        const sent = await client.invoke(
          new Api.auth.SendCode({
            phoneNumber: phone,
            ...auth,
            settings: new Api.CodeSettings({}),
          }),
        );
        if (!(sent instanceof Api.auth.SentCode))
          throw new TelegramSendError(
            'login_restart',
            'Повторіть підключення Telegram.',
          );
        return {
          session: client.session.save(),
          phoneCodeHash: sent.phoneCodeHash,
          deliveryUk: codeDelivery(sent.type),
        };
      });
    },
    /**
     * QR login (Telegram → Settings → Devices → Link Desktop Device): no code message needed.
     * Call repeatedly with the returned session until the status is 'done' or 'password'.
     */
    qrLogin(session: string) {
      return temporary(session, async (client, auth) => {
        const phoneOf = (authorization: unknown) => {
          const user = (authorization as Api.auth.Authorization).user as
            Api.User | undefined;
          return user?.phone ? `+${user.phone}` : null;
        };
        try {
          const result = await client.invoke(
            new Api.auth.ExportLoginToken({ ...auth, exceptIds: [] }),
          );
          console.info('[telegram-qr] export:', result.className);
          if (result instanceof Api.auth.LoginTokenMigrateTo) {
            // The account lives on another data center. GramJS _switchDC hangs in this
            // short-lived client, so import the token through a fresh client on that DC.
            const target = result;
            const config = await client.invoke(new Api.help.GetConfig());
            const option = config.dcOptions.find(
              (o) =>
                o.id === target.dcId &&
                !o.ipv6 &&
                !o.mediaOnly &&
                !o.cdn &&
                !o.tcpoOnly,
            );
            if (!option)
              throw new TelegramSendError(
                'login_restart',
                'Повторіть підключення Telegram.',
              );
            console.info('[telegram-qr] migrate to DC', target.dcId);
            const other = factory('', auth, {
              id: target.dcId,
              ip: option.ipAddress,
              port: option.port,
            });
            try {
              await other.connect();
              const imported = await other.invoke(
                new Api.auth.ImportLoginToken({ token: target.token }),
              );
              console.info('[telegram-qr] import:', imported.className);
              if (imported instanceof Api.auth.LoginTokenSuccess)
                return {
                  session: other.session.save(),
                  status: 'done' as const,
                  phone: phoneOf(imported.authorization),
                };
              throw new TelegramSendError(
                'login_restart',
                'Повторіть підключення Telegram.',
              );
            } catch (error) {
              if (
                (error as { errorMessage?: string }).errorMessage ===
                'SESSION_PASSWORD_NEEDED'
              )
                return {
                  session: other.session.save(),
                  status: 'password' as const,
                };
              throw error;
            } finally {
              await Promise.race([
                other.destroy().catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 3000)),
              ]);
            }
          }
          if (result instanceof Api.auth.LoginTokenSuccess)
            return {
              session: client.session.save(),
              status: 'done' as const,
              phone: phoneOf(result.authorization),
            };
          if (result instanceof Api.auth.LoginToken)
            return {
              session: client.session.save(),
              status: 'qr' as const,
              url: `tg://login?token=${Buffer.from(result.token).toString('base64url')}`,
            };
          throw new TelegramSendError(
            'login_restart',
            'Повторіть підключення Telegram.',
          );
        } catch (error) {
          if (
            (error as { errorMessage?: string }).errorMessage ===
            'SESSION_PASSWORD_NEEDED'
          )
            return {
              session: client.session.save(),
              status: 'password' as const,
            };
          throw error;
        }
      });
    },
    finishLogin(input: {
      session: string;
      phone: string;
      phoneCodeHash: string;
      code?: string;
      password?: string;
    }) {
      return temporary(input.session, async (client) => {
        try {
          if (input.password) {
            const params = await client.invoke(new Api.account.GetPassword());
            const signed = await client.invoke(
              new Api.auth.CheckPassword({
                password: await computeCheck(params, input.password),
              }),
            );
            const user = (signed as Api.auth.Authorization).user as
              Api.User | undefined;
            return {
              session: client.session.save(),
              requiresPassword: false,
              ...(user?.phone ? { phone: `+${user.phone}` } : {}),
            };
          } else {
            if (!input.code)
              throw new TelegramSendError(
                'invalid_code',
                'Введіть код підтвердження Telegram.',
              );
            const result = await client.invoke(
              new Api.auth.SignIn({
                phoneNumber: input.phone,
                phoneCodeHash: input.phoneCodeHash,
                phoneCode: input.code,
              }),
            );
            if (result instanceof Api.auth.AuthorizationSignUpRequired)
              throw new TelegramSendError(
                'signup_required',
                'Спочатку зареєструйте акаунт у застосунку Telegram.',
              );
          }
          return { session: client.session.save(), requiresPassword: false };
        } catch (error) {
          if (
            (error as { errorMessage?: string }).errorMessage ===
            'SESSION_PASSWORD_NEEDED'
          )
            return { session: client.session.save(), requiresPassword: true };
          throw error;
        }
      });
    },
    logout(session: string) {
      return temporary(session, async (client) => {
        await client.invoke(new Api.auth.LogOut());
      });
    },
    async send(message: TelegramSendRequest): Promise<string> {
      const to = normalizeTelegramRecipient(message.to);
      if (!to)
        throw new TelegramSendError(
          'recipient',
          'Вкажіть username Telegram або номер у форматі E.164.',
          false,
          undefined,
          true,
        );
      const randomId = telegramRandomId(message.idempotencyKey);
      let client: TelegramConnection;
      try {
        let pending = clients.get(message.accountId);
        if (!pending) {
          const created = factory(message.session, credentials());
          pending = created
            .connect()
            .then(() => created)
            .catch(async (error: unknown) => {
              await created.destroy().catch(() => {});
              clients.delete(message.accountId);
              throw error;
            });
          clients.set(message.accountId, pending);
        }
        client = await pending;
        let peer: Api.TypeInputPeer;
        let cleanup:
          Api.contacts.DeleteContacts | Api.contacts.DeleteByPhones | undefined;
        let providerMessageId: string | undefined;
        let sendError: TelegramSendError | undefined;
        try {
          // Like the old Sonar: resolve the phone directly (no contact import, no import limit).
          let resolved: Api.User | undefined;
          if (to.startsWith('+')) {
            try {
              const found = await client.invoke(
                new Api.contacts.ResolvePhone({ phone: to.slice(1) }),
              );
              if (!found?.users?.length)
                console.info('[telegram] resolvePhone: no users');
              resolved = found?.users?.find(
                (user): user is Api.User =>
                  user instanceof Api.User && !!user.accessHash,
              );
            } catch (error) {
              const code = (error as { errorMessage?: string }).errorMessage;
              if (code?.startsWith('FLOOD')) throw error;
              console.info('[telegram] resolvePhone:', code ?? 'unknown error');
              // PHONE_NOT_OCCUPIED or a hidden number: fall back to importing the contact.
            }
          }
          if (resolved)
            peer = new Api.InputPeerUser({
              userId: resolved.id,
              accessHash: resolved.accessHash!,
            });
          else if (to.startsWith('+')) {
            const existing = await client.invoke(
              new Api.contacts.GetContacts({ hash: returnBigInt(0) }),
            );
            if (!(existing instanceof Api.contacts.Contacts))
              throw new TelegramSendError(
                'contacts',
                'Не вдалося перевірити контакти Telegram.',
                true,
              );
            const saved = existing.users.find(
              (user) =>
                user instanceof Api.User &&
                user.phone === to.slice(1) &&
                existing.contacts.some((item) => item.userId.equals(user.id)),
            );
            const imported = await client.invoke(
              new Api.contacts.ImportContacts({
                contacts: [
                  new Api.InputPhoneContact({
                    clientId: randomId,
                    phone: to,
                    firstName:
                      saved instanceof Api.User
                        ? (saved.firstName ?? '')
                        : 'Sonar',
                    lastName:
                      saved instanceof Api.User ? (saved.lastName ?? '') : '',
                  }),
                ],
              }),
            );
            const user =
              imported.users.find(
                (user) =>
                  user instanceof Api.User &&
                  imported.imported.some((item) => item.userId.equals(user.id)),
              ) ?? saved;
            const importedId = imported.imported[0]?.userId;
            if (
              importedId &&
              !existing.contacts.some((item) => item.userId.equals(importedId))
            ) {
              cleanup =
                user instanceof Api.User && user.accessHash
                  ? new Api.contacts.DeleteContacts({
                      id: [
                        new Api.InputUser({
                          userId: importedId,
                          accessHash: user.accessHash,
                        }),
                      ],
                    })
                  : new Api.contacts.DeleteByPhones({ phones: [to] });
            }
            if (imported.retryContacts.length)
              throw new TelegramSendError(
                'import_retry',
                'Telegram тимчасово не імпортував контакт. Повторіть спробу пізніше.',
                true,
              );
            if (!(user instanceof Api.User) || !user.accessHash)
              throw new TelegramSendError(
                'unavailable',
                'Telegram недоступний: номер прихований або не зареєстрований.',
                false,
                undefined,
                true,
              );
            peer = new Api.InputPeerUser({
              userId: user.id,
              accessHash: user.accessHash,
            });
          } else peer = await client.getInputEntity(to);
          const result = await client.invoke(
            new Api.messages.SendMessage({
              peer,
              message: message.body,
              randomId,
              noWebpage: true,
            }),
          );
          const update =
            'updates' in result
              ? result.updates.find(
                  (update) =>
                    update instanceof Api.UpdateMessageID &&
                    update.randomId?.equals(randomId),
                )
              : undefined;
          const id =
            result instanceof Api.UpdateShortSentMessage
              ? result.id
              : update instanceof Api.UpdateMessageID
                ? update.id
                : undefined;
          if (id === undefined)
            throw new TelegramSendError(
              'delivery_uncertain',
              'Telegram не підтвердив ідентифікатор повідомлення. Перевірте доставку вручну.',
            );
          providerMessageId = String(id);
        } catch (error) {
          sendError = telegramError(error);
        }
        if (cleanup) {
          const remove = () => client.invoke(cleanup);
          let cleanupError: TelegramSendError | undefined;
          try {
            await remove();
          } catch (error) {
            cleanupError = telegramError(error);
            if (!cleanupError.retryAfterSeconds) {
              try {
                await remove();
                cleanupError = undefined;
              } catch (retryError) {
                cleanupError = telegramError(retryError);
              }
            }
          }
          if (cleanupError) {
            // Preserve delivery evidence so callers record sent without retrying.
            if (providerMessageId) {
              const error = new TelegramSendError(
                'cleanup_failed',
                'Повідомлення надіслано. Не вдалося видалити тимчасовий контакт Telegram; видаліть його вручну.',
              );
              error.providerMessageId = providerMessageId;
              error.accountRetryAfterSeconds = cleanupError.retryAfterSeconds;
              throw error;
            }
            if (sendError)
              sendError.accountRetryAfterSeconds =
                cleanupError.retryAfterSeconds;
          }
        }
        if (sendError) throw sendError;
        return providerMessageId!;
      } catch (error) {
        throw telegramError(error);
      }
    },
    close,
    async closeAll() {
      await Promise.all([...clients.keys()].map(close));
    },
  };
}
export const telegramAdapter = createTelegramAdapter();
