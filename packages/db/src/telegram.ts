import type { PoolClient } from 'pg';
import {
  telegramAdapter,
  TelegramSendError,
  encryptTelegramSession,
  decryptTelegramSession,
  normalizeTelegramRecipient,
} from '@sonar/core/telegram';
import { sonarPool } from './index.js';
import { EmailValidationError, transaction } from './email.js';
import { logActivity } from './tasks.js';

type Adapter = Pick<
  typeof telegramAdapter,
  'startLogin' | 'finishLogin' | 'logout' | 'close'
>;
export interface TelegramAccount {
  id: string;
  name: string;
  address: string;
  dailyLimit: number;
  sentToday: number;
  enabled: boolean;
  nextSendAt: Date | null;
  ownerName: string | null;
  status: string;
}
async function loginOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TelegramSendError)
      throw new EmailValidationError(error.reasonUk);
    throw new EmailValidationError(
      'Не вдалося виконати запит Telegram. Повторіть спробу.',
    );
  }
}
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
const secret = () => {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32)
    invalid('Налаштуйте AUTH_SECRET на сервері (щонайменше 32 символи).');
  return value!;
};
const validLimit = (limit: number) =>
  Number.isInteger(limit) && limit > 0 && limit <= 100000;
const maskPhone = (phone: string) =>
  `+${'•'.repeat(Math.max(4, phone.length - 5))}${phone.slice(-4)}`;
export async function listTelegramAccounts(): Promise<TelegramAccount[]> {
  const { rows } = await sonarPool.query(
    `select a.id,a.name,a.address,a.daily_limit as "dailyLimit",a.status,(a.status='active') as enabled,a.next_send_at as "nextSendAt",u.name as "ownerName",(select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday" from channel_accounts a left join users u on u.id=a.owner_id where a.channel='telegram' and a.status<>'pending' order by a.name,a.id`,
  );
  return rows.map((a) => ({ ...a, address: maskPhone(a.address) }));
}
async function lockAccount(c: PoolClient, id: string, userId: string) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [id],
  );
  const {
    rows: [a],
  } = await c.query(
    "select * from channel_accounts where id=$1 and channel='telegram' and owner_id=$2 for update",
    [id, userId],
  );
  if (!a) invalid('Акаунт Telegram не знайдено.');
  return a;
}
export async function beginTelegramLogin(
  input: { name: string; phone: string; dailyLimit: number },
  userId: string,
  adapter: Adapter = telegramAdapter,
  now = new Date(),
) {
  const phone = normalizeTelegramRecipient(input.phone ?? ''),
    name = input.name?.trim();
  if (
    !phone?.startsWith('+') ||
    !name ||
    name.length > 200 ||
    !validLimit(input.dailyLimit)
  )
    invalid('Вкажіть назву, міжнародний телефон та додатний денний ліміт.');
  const encryptionSecret = secret();
  return transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('telegram-login:'||$1::text,0))",
      [userId],
    );
    await c.query(
      "delete from channel_accounts where channel='telegram' and owner_id=$1 and status='pending' and (settings->>'expiresAt')::timestamptz <= $2",
      [userId, now],
    );
    const login = await loginOperation(() => adapter.startLogin(phone!));
    const {
      rows: [account],
    } = await c.query(
      "insert into channel_accounts(channel,name,address,owner_id,status,daily_limit,settings) values('telegram',$1,$2,$3,'pending',$4,$5) returning id",
      [
        name,
        phone,
        userId,
        input.dailyLimit,
        JSON.stringify({
          pending: encryptTelegramSession(
            JSON.stringify(login),
            encryptionSecret,
          ),
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        }),
      ],
    );
    return { id: String(account.id), step: 'code' as const };
  });
}
export async function completeTelegramLogin(
  id: string,
  input: { code?: string; password?: string },
  userId: string,
  adapter: Adapter = telegramAdapter,
  now = new Date(),
) {
  if (
    (!input.code?.trim() && !input.password) ||
    (input.code?.length ?? 0) > 20 ||
    (input.password?.length ?? 0) > 1024
  )
    invalid('Вкажіть код Telegram або пароль двоетапної перевірки.');
  return transaction(async (c) => {
    const account = await lockAccount(c, id, userId),
      settings = account.settings;
    if (
      account.status !== 'pending' ||
      !settings.pending ||
      new Date(settings.expiresAt).getTime() <= now.getTime()
    )
      invalid('Сеанс входу закінчився. Запросіть новий код.');
    const login = JSON.parse(
      decryptTelegramSession(settings.pending, secret()),
    ) as { session: string; phoneCodeHash: string; requiresPassword?: boolean };
    if (login.requiresPassword ? !input.password : !input.code?.trim())
      invalid(
        login.requiresPassword
          ? 'Вкажіть пароль двоетапної перевірки.'
          : 'Вкажіть код Telegram.',
      );
    const result = await loginOperation(() =>
      adapter.finishLogin({
        session: login.session,
        phone: account.address,
        phoneCodeHash: login.phoneCodeHash,
        code: input.code?.trim(),
        password: input.password,
      }),
    );
    if (result.requiresPassword) {
      await c.query('update channel_accounts set settings=$2 where id=$1', [
        id,
        JSON.stringify({
          ...settings,
          pending: encryptTelegramSession(
            JSON.stringify({
              ...login,
              session: result.session,
              requiresPassword: true,
            }),
            secret(),
          ),
        }),
      ]);
      return { id, step: 'password' as const };
    }
    await c.query(
      "update channel_accounts set status='active',settings=$2 where id=$1",
      [
        id,
        JSON.stringify({
          sessionEncrypted: encryptTelegramSession(result.session, secret()),
        }),
      ],
    );
    await logActivity(
      'telegram.account.connected',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return { id, step: 'done' as const };
  });
}
export async function updateTelegramAccount(
  id: string,
  input: { dailyLimit?: number; enabled?: boolean },
  userId: string,
) {
  if (
    (input.dailyLimit === undefined && input.enabled === undefined) ||
    (input.dailyLimit !== undefined && !validLimit(input.dailyLimit)) ||
    (input.enabled !== undefined && typeof input.enabled !== 'boolean')
  )
    invalid('Вкажіть додатний денний ліміт та стан акаунта.');
  return transaction(async (c) => {
    const account = await lockAccount(c, id, userId);
    if (!account.settings.sessionEncrypted)
      invalid('Спочатку підключіть акаунт Telegram.');
    await c.query(
      'update channel_accounts set daily_limit=$2,status=$3 where id=$1',
      [
        id,
        input.dailyLimit ?? account.daily_limit,
        input.enabled === undefined
          ? account.status
          : input.enabled
            ? 'active'
            : 'disabled',
      ],
    );
    await logActivity(
      'telegram.account.updated',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}
export async function logoutTelegramAccount(
  id: string,
  userId: string,
  adapter: Adapter = telegramAdapter,
) {
  return transaction(async (c) => {
    const account = await lockAccount(c, id, userId);
    if (account.settings.sessionEncrypted) {
      try {
        await loginOperation(async () => {
          try {
            await adapter.logout(
              decryptTelegramSession(
                account.settings.sessionEncrypted,
                secret(),
              ),
            );
          } catch (error) {
            if (
              !(error instanceof TelegramSendError) ||
              error.code !== 'session_expired'
            )
              throw error;
          }
        });
      } finally {
        await adapter.close(id);
      }
    }
    await c.query(
      "update channel_accounts set status='disconnected',settings='{}'::jsonb,next_send_at=null where id=$1",
      [id],
    );
    await logActivity(
      'telegram.account.disconnected',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}
