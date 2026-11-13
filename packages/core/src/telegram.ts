import { createHash } from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { computeCheck } from 'telegram/Password.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
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
  if (/^telegram:user:[1-9]\d*(?::-?\d+)?$/.test(value)) return value;
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
  onIncoming?: (handler: (message: TelegramIncoming) => Promise<void>) => void;
};
type Credentials = { apiId: number; apiHash: string };
export type TelegramClientFactory = (
  session: string,
  credentials: Credentials,
) => TelegramConnection;
function gramClient(
  session: string,
  credentials: Credentials,
): TelegramConnection {
  const saved = new StringSession(session);
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
  client.onError = async () => {
    console.error(
      'Telegram update processing failed; check incoming task queue.',
    );
  };
  return {
    connect: () => client.connect(),
    invoke: client.invoke.bind(client),
    getInputEntity: client.getInputEntity.bind(client),
    destroy: () => client.destroy(),
    switchDC: (dc: number) => client._switchDC(dc),
    session: saved,
    onIncoming(handler) {
      client.addEventHandler(
        async (event: NewMessageEvent) => {
          if (!event.isPrivate || event.message.out) return;
          const sender = await event.message.getSender();
          if (!(sender instanceof Api.User) || sender.bot || sender.self)
            return;
          await handler({
            providerId: `${sender.id}:${event.message.id}`,
            sender: sender.username
              ? `@${sender.username}`
              : sender.phone
                ? `+${sender.phone}`
                : `telegram:user:${sender.id}${sender.accessHash ? `:${sender.accessHash}` : ''}`,
            senderPhone: sender.phone ? `+${sender.phone}` : undefined,
            body: event.message.message || '',
            receivedAt: new Date(event.message.date * 1000).toISOString(),
          });
        },
        new NewMessage({ incoming: true }),
      );
    },
  };
}
export type TelegramIncoming = {
  providerId: string;
  sender: string;
  senderPhone?: string;
  body: string;
  receivedAt: string;
};
export type TelegramSendRequest = {
  accountId: string;
  session: string;
  to: string;
  body: string;
  idempotencyKey: string;
};
export function createTelegramAdapter(
  config: { apiId?: string | number; apiHash?: string } = {},
  factory: TelegramClientFactory = gramClient,
) {
  const clients = new Map<string, Promise<TelegramConnection>>();
  const listening = new Set<string>();
  const sessions = new Map<string, string>();
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
    try {
      const auth = credentials();
      client = factory(session, auth);
      await client.connect();
      return await run(client, auth);
    } catch (error) {
      throw telegramError(error);
    } finally {
      await client?.destroy().catch(() => {});
    }
  }
  async function close(accountId: string) {
    const pending = clients.get(accountId);
    clients.delete(accountId);
    listening.delete(accountId);
    sessions.delete(accountId);
    if (pending)
      await pending.then((client) => client.destroy()).catch(() => {});
  }
  async function connection(accountId: string, session: string) {
    if (clients.has(accountId) && sessions.get(accountId) !== session)
      await close(accountId);
    let pending = clients.get(accountId);
    if (!pending) {
      const created = factory(session, credentials());
      pending = created
        .connect()
        .then(() => created)
        .catch(async (error: unknown) => {
          await created.destroy().catch(() => {});
          clients.delete(accountId);
          throw error;
        });
      clients.set(accountId, pending);
      sessions.set(accountId, session);
    }
    return pending;
  }
  return {
    async listen(
      accountId: string,
      session: string,
      handler: (message: TelegramIncoming) => Promise<void>,
    ) {
      const client = await connection(accountId, session);
      if (listening.has(accountId)) return;
      if (!client.onIncoming) throw new Error('Telegram updates unavailable');
      client.onIncoming(handler);
      listening.add(accountId);
    },
    listeningAccounts: () => [...listening],
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
          let result = await client.invoke(
            new Api.auth.ExportLoginToken({ ...auth, exceptIds: [] }),
          );
          if (result instanceof Api.auth.LoginTokenMigrateTo) {
            if (!client.switchDC)
              throw new TelegramSendError(
                'login_restart',
                'Повторіть підключення Telegram.',
              );
            await client.switchDC(result.dcId);
            result = await client.invoke(
              new Api.auth.ImportLoginToken({ token: result.token }),
            );
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
        client = await connection(message.accountId, message.session);
        let peer: Api.TypeInputPeer;
        let cleanup:
          Api.contacts.DeleteContacts | Api.contacts.DeleteByPhones | undefined;
        let providerMessageId: string | undefined;
        let sendError: TelegramSendError | undefined;
        try {
          if (to.startsWith('+')) {
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
          } else if (to.startsWith('telegram:user:')) {
            const [, , userId, accessHash] = to.split(':');
            peer = accessHash
              ? new Api.InputPeerUser({
                  userId: returnBigInt(userId!),
                  accessHash: returnBigInt(accessHash),
                })
              : await client.getInputEntity(
                  new Api.PeerUser({ userId: returnBigInt(userId!) }),
                );
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
