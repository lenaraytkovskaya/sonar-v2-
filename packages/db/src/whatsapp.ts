import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  whatsappAdapter,
  whatsappError,
  type WhatsAppSession,
} from '@sonar/core/whatsapp';
import { sonarPool } from './index.js';
import { EmailValidationError, transaction } from './email.js';
import { logActivity } from './tasks.js';

type Adapter = Pick<
  typeof whatsappAdapter,
  'start' | 'getSession' | 'getQr' | 'restart' | 'logout'
>;
type Status = 'active' | 'qr' | 'starting' | 'failed' | 'stopped';
export interface WhatsAppAccount {
  id: string;
  name: string;
  address: string;
  dailyLimit: number;
  sentToday: number;
  enabled: boolean;
  desiredEnabled: boolean;
  nextSendAt: Date | null;
  ownerName: string | null;
  status: Status;
  reasonUk: string | null;
  providerName?: string;
}
export interface WhatsAppAccountState {
  id: string;
  status: Status;
  reasonUk: string | null;
  qr?: string;
}
const validLimit = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= 100000;
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
const statusOf = (status?: string): Status =>
  status === 'WORKING'
    ? 'active'
    : status === 'SCAN_QR_CODE'
      ? 'qr'
      : status === 'STARTING'
        ? 'starting'
        : status === 'STOPPED'
          ? 'stopped'
          : 'failed';
const reasonOf = (status: Status) =>
  status === 'failed'
    ? 'Сесія WhatsApp не працює. Перезапустіть її та відскануйте QR-код.'
    : status === 'stopped'
      ? 'Сесію WhatsApp зупинено. Підключіть акаунт повторно.'
      : null;
export async function listWhatsAppAccounts(): Promise<WhatsAppAccount[]> {
  const { rows } = await sonarPool.query(
    `select a.id,a.name,a.address,a.status as "accountStatus",a.daily_limit as "dailyLimit",a.settings,a.next_send_at as "nextSendAt",u.name as "ownerName",(select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday" from channel_accounts a left join users u on u.id=a.owner_id where a.channel='whatsapp' order by a.name,a.id`,
  );
  return rows.map(({ settings, accountStatus, ...account }) => {
    const status =
      accountStatus === 'paused' ? 'failed' : statusOf(settings.providerStatus);
    return {
      ...account,
      address: account.address.startsWith('+')
        ? `+${'•'.repeat(Math.max(4, account.address.length - 5))}${account.address.slice(-4)}`
        : '—',
      status,
      enabled: accountStatus === 'active' && settings.enabled !== false,
      desiredEnabled: settings.enabled !== false,
      providerName: settings.providerName,
      reasonUk: settings.reasonUk ?? reasonOf(status),
    };
  });
}
async function lock(c: PoolClient, id: string, userId: string) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [id],
  );
  const {
    rows: [account],
  } = await c.query(
    "select * from channel_accounts where id=$1 and channel='whatsapp' and owner_id=$2 for update",
    [id, userId],
  );
  if (!account) invalid('Акаунт WhatsApp не знайдено.');
  return account;
}
type AccountRow = Awaited<ReturnType<typeof lock>>;
async function external(
  c: PoolClient,
  account: AccountRow,
  operation: 'start' | 'refresh' | 'restart' | 'logout',
  userId: string,
  adapter: Adapter,
): Promise<WhatsAppAccountState> {
  const id = randomUUID();
  let session: WhatsAppSession | null = null,
    qr: string | undefined,
    failure: ReturnType<typeof whatsappError> | undefined;
  try {
    if (operation === 'logout') {
      await adapter.logout();
      session = { status: 'STOPPED', phone: null };
    } else {
      session = await (operation === 'refresh'
        ? adapter.getSession()
        : operation === 'start'
          ? adapter.start()
          : adapter.restart());
      // WAHA fails a session whose QR codes expired unscanned; while the page is open, start over.
      if (
        operation === 'refresh' &&
        session?.status === 'FAILED' &&
        ['SCAN_QR_CODE', 'STARTING'].includes(account.settings.providerStatus)
      ) {
        operation = 'restart';
        session = await adapter.restart();
      }
      if (session?.status === 'SCAN_QR_CODE') qr = await adapter.getQr();
    }
  } catch (error) {
    failure = whatsappError(error);
  }
  const status = failure ? 'failed' : statusOf(session?.status ?? 'STOPPED'),
    reasonUk = failure?.reasonUk ?? reasonOf(status);
  const settings = {
    session: 'default',
    enabled: account.settings.enabled !== false,
    providerStatus: failure ? 'FAILED' : (session?.status ?? 'STOPPED'),
    providerName: session?.name ?? account.settings.providerName,
    reasonUk,
  };
  await c.query(
    'update channel_accounts set status=$2,address=$3,settings=$4 where id=$1',
    [
      account.id,
      status === 'active' && !settings.enabled ? 'disabled' : status,
      session?.phone ?? (operation === 'logout' ? 'default' : account.address),
      JSON.stringify(settings),
    ],
  );
  // Status polling is recorded only when something changed, so the task log stays readable.
  if (
    operation === 'refresh' &&
    !failure &&
    settings.providerStatus === account.settings.providerStatus
  )
    return { id: account.id, status, reasonUk, ...(qr ? { qr } : {}) };
  await c.query(
    "insert into tasks(id,type,status,subject_type,subject_id,idempotency_key,payload,attempts,started_at,result,reason_code,reason_uk,finished_at) values($1,$2,$3,'channel_account',$4,$5,$6,1,now(),$7,$8,$9,now())",
    [
      id,
      `whatsapp.account.${operation}`,
      failure ? 'failed' : 'done',
      account.id,
      `whatsapp.account:${id}`,
      JSON.stringify({ accountId: account.id }),
      JSON.stringify({ status }),
      failure?.code ?? null,
      failure?.reasonUk ?? null,
    ],
  );
  await logActivity(
    `whatsapp.account.${operation}`,
    'channel_account',
    account.id,
    userId,
    { status, taskId: id },
    c,
  );
  // Preserve the failed task and fail closed even when the caller's connection fails.
  return { id: account.id, status, reasonUk, ...(qr ? { qr } : {}) };
}
export async function connectWhatsAppAccount(
  input: { name: string; dailyLimit: number },
  userId: string,
  adapter: Adapter = whatsappAdapter,
): Promise<WhatsAppAccountState> {
  const name = input.name?.trim();
  if (!name || name.length > 200 || !validLimit(input.dailyLimit))
    invalid('Вкажіть назву та додатний денний ліміт WhatsApp.');
  return transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('whatsapp:default',0))",
    );
    let {
      rows: [account],
    } = await c.query(
      "select * from channel_accounts where channel='whatsapp'",
    );
    if (account && account.owner_id !== userId)
      invalid(
        'WAHA Core підтримує один номер. Акаунт уже підключено іншим учасником.',
      );
    if (!account) {
      const result = await c.query(
        "insert into channel_accounts(channel,name,address,owner_id,status,daily_limit,settings) values('whatsapp',$1,'default',$2,'stopped',$3,$4) returning *",
        [
          name,
          userId,
          input.dailyLimit,
          JSON.stringify({
            session: 'default',
            enabled: true,
            providerStatus: 'STOPPED',
          }),
        ],
      );
      account = result.rows[0];
    } else {
      account = await lock(c, account.id, userId);
      await c.query(
        'update channel_accounts set name=$2,daily_limit=$3 where id=$1',
        [account.id, name, input.dailyLimit],
      );
    }
    return external(c, account, 'start', userId, adapter);
  });
}
async function lifecycle(
  id: string,
  userId: string,
  operation: 'refresh' | 'restart' | 'logout',
  adapter: Adapter,
) {
  return transaction(async (c) =>
    external(c, await lock(c, id, userId), operation, userId, adapter),
  );
}
export const refreshWhatsAppAccount = (
  id: string,
  userId: string,
  adapter: Adapter = whatsappAdapter,
) => lifecycle(id, userId, 'refresh', adapter);
export const restartWhatsAppAccount = (
  id: string,
  userId: string,
  adapter: Adapter = whatsappAdapter,
) => lifecycle(id, userId, 'restart', adapter);
export async function logoutWhatsAppAccount(
  id: string,
  userId: string,
  adapter: Adapter = whatsappAdapter,
) {
  const result = await lifecycle(id, userId, 'logout', adapter);
  if (result.status === 'failed') invalid(result.reasonUk!);
  return true;
}
export async function updateWhatsAppAccount(
  id: string,
  input: { dailyLimit?: number; enabled?: boolean },
  userId: string,
) {
  if (
    (input.dailyLimit === undefined && input.enabled === undefined) ||
    (input.dailyLimit !== undefined && !validLimit(input.dailyLimit)) ||
    (input.enabled !== undefined && typeof input.enabled !== 'boolean')
  )
    invalid('Вкажіть додатний денний ліміт та стан акаунта WhatsApp.');
  return transaction(async (c) => {
    const account = await lock(c, id, userId),
      settings = {
        ...account.settings,
        enabled: input.enabled ?? account.settings.enabled !== false,
      };
    const status =
      account.status === 'paused'
        ? 'paused'
        : statusOf(settings.providerStatus);
    await c.query(
      'update channel_accounts set daily_limit=$2,status=$3,settings=$4 where id=$1',
      [
        id,
        input.dailyLimit ?? account.daily_limit,
        status === 'active' && !settings.enabled ? 'disabled' : status,
        JSON.stringify(settings),
      ],
    );
    await logActivity(
      'whatsapp.account.updated',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return true;
  });
}
