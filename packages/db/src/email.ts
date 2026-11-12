import type { PoolClient } from 'pg';
import {
  EmailSendError,
  messageStatusForMode,
  normalizePhone,
  nextSendTime,
  testModeAllows,
  testModeReason,
  type SendHours,
  type CountryCode,
} from '@sonar/core';
import {
  normalizeTelegramRecipient,
  TelegramSendError,
  decryptTelegramSession,
} from '@sonar/core/telegram';
import { listTelegramAccounts } from './telegram.js';
import {
  normalizeWhatsAppRecipient,
  WhatsAppSendError,
} from '@sonar/core/whatsapp';
import { listWhatsAppAccounts } from './whatsapp.js';
import { sonarPool } from './index.js';
import {
  enqueueTask,
  logActivity,
  TaskFailure,
  type TaskOutcome,
} from './tasks.js';

type SendMode = 'auto' | 'approval' | 'manual';
export class EmailValidationError extends Error {
  constructor(public reasonUk: string) {
    super(reasonUk);
  }
}
export interface EmailAccount {
  id: string;
  name: string;
  fromAddress: string;
  dailyLimit: number;
  sentToday: number;
  enabled: boolean;
  nextSendAt: Date | null;
  ownerName: string | null;
}
export interface EmailMessage {
  id: string;
  channel: 'email' | 'form' | 'telegram' | 'whatsapp';
  screenshotBefore: boolean;
  screenshotAfter: boolean;
  accountId: string;
  toAddress: string;
  subject: string;
  body: string;
  status:
    | 'draft'
    | 'awaiting_approval'
    | 'awaiting_manual'
    | 'queued'
    | 'sent'
    | 'delivered'
    | 'read'
    | 'failed';
  createdAt: Date;
  sentAt: Date | null;
  scheduledAt: Date | null;
  reasonUk: string | null;
}
export type EmailRequest = {
  from: string;
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};
export type EmailSender = (request: EmailRequest) => Promise<string>;
const validEmail = (value: string) =>
  /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= 254;
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
export async function transaction<T>(
  fn: (c: PoolClient) => Promise<T>,
  existing?: PoolClient,
): Promise<T> {
  if (existing) return fn(existing);
  const c = await sonarPool.connect();
  try {
    await c.query('begin');
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export async function listEmailAccounts(): Promise<EmailAccount[]> {
  return (
    await sonarPool.query(`select a.id,a.name,a.address as "fromAddress",a.daily_limit as "dailyLimit",(a.status='active') as enabled,a.next_send_at as "nextSendAt",u.name as "ownerName",
    (select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday"
    from channel_accounts a left join users u on u.id=a.owner_id where a.channel='email' and a.status<>'removed' order by a.name,a.id`)
  ).rows;
}
export async function countSentToday(): Promise<number> {
  return (
    await sonarPool.query(
      "select count(*)::int as total from messages where sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'",
    )
  ).rows[0].total;
}
/** Deletes an email account; one with message history is hidden instead so the history stays intact. */
export async function removeEmailAccount(id: string, userId: string) {
  return transaction(async (c) => {
    const {
      rows: [used],
    } = await c.query(
      'select exists(select 1 from messages where account_id=$1) as used',
      [id],
    );
    const { rowCount } = used.used
      ? await c.query(
          "update channel_accounts set status='removed' where id=$1 and channel='email'",
          [id],
        )
      : await c.query(
          "delete from channel_accounts where id=$1 and channel='email'",
          [id],
        );
    if (!rowCount) invalid('Акаунт не знайдено.');
    await logActivity(
      'email.account.removed',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return { id };
  });
}
export async function setEmailAccountEnabled(
  id: string,
  enabled: boolean,
  userId: string,
) {
  return transaction(async (c) => {
    const { rowCount } = await c.query(
      "update channel_accounts set status=$2 where id=$1 and channel='email'",
      [id, enabled ? 'active' : 'disabled'],
    );
    if (!rowCount) invalid('Акаунт не знайдено.');
    await logActivity(
      enabled ? 'email.account.enabled' : 'email.account.disabled',
      'channel_account',
      id,
      userId,
      {},
      c,
    );
    return { id };
  });
}
export async function createEmailAccount(
  input: { name: string; fromAddress: string; dailyLimit: number },
  userId: string,
) {
  const name = input.name?.trim(),
    address = input.fromAddress?.trim().toLowerCase();
  if (
    !name ||
    name.length > 200 ||
    !validEmail(address) ||
    !Number.isInteger(input.dailyLimit) ||
    input.dailyLimit < 1 ||
    input.dailyLimit > 100000
  )
    invalid(
      'Вкажіть назву, коректну адресу відправника та додатний денний ліміт.',
    );
  return transaction(async (c) => {
    const {
      rows: [account],
    } = await c.query(
      'insert into channel_accounts(name,address,daily_limit,owner_id) values($1,$2,$3,$4) returning id',
      [name, address, input.dailyLimit, userId],
    );
    await logActivity(
      'email.account.created',
      'channel_account',
      account.id,
      userId,
      {},
      c,
    );
    return { id: String(account.id) };
  });
}
async function telegramContacts(
  c: Pick<PoolClient, 'query'>,
  companyId: string,
  to: string,
) {
  const { rows } = await c.query(
    "select id,normalized,meta from contacts where company_id=$1 and kind in ('telegram','phone') for share",
    [companyId],
  );
  return rows.filter(
    (r) =>
      normalizeTelegramRecipient(r.normalized)?.toLowerCase() ===
      to.toLowerCase(),
  );
}
async function whatsappContacts(
  c: Pick<PoolClient, 'query'>,
  companyId: string,
  to: string,
  country?: CountryCode,
) {
  const { rows } = await c.query(
    "select id,normalized,meta from contacts where company_id=$1 and kind in ('whatsapp','phone') for share",
    [companyId],
  );
  return rows.filter(
    (r) => normalizeWhatsAppRecipient(r.normalized, country) === to,
  );
}
/** Returns a reason when test mode is on and the recipient is not on the owner's list. */
export async function testModeBlock(
  c: Pick<PoolClient, 'query'>,
  to: string,
  country?: CountryCode,
): Promise<string | null> {
  const { rows } = await c.query(
    "select key,value from settings where key in ('send.test_mode','send.test_allowlist')",
  );
  const config = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (config['send.test_mode'] === false) return null;
  const list = Array.isArray(config['send.test_allowlist'])
    ? (config['send.test_allowlist'] as string[])
    : [];
  return testModeAllows(to ?? '', list, country) ? null : testModeReason;
}
export async function isContactBlocked(
  c: Pick<PoolClient, 'query'>,
  companyId: string,
  address = '',
  country?: CountryCode,
): Promise<boolean> {
  const whatsappTo = normalizeWhatsAppRecipient(address, country);
  if (whatsappTo) {
    const { rows } = await c.query(
      "select value_normalized from do_not_contact where kind in ('whatsapp','phone')",
    );
    if (
      rows.some(
        (r) =>
          normalizeWhatsAppRecipient(r.value_normalized, country) ===
          whatsappTo,
      )
    )
      return true;
  }
  const telegramTo = normalizeTelegramRecipient(address);
  if (telegramTo) {
    const { rows } = await c.query(
      "select value_normalized from do_not_contact where kind in ('telegram','phone')",
    );
    if (
      rows.some(
        (r) =>
          normalizeTelegramRecipient(r.value_normalized)?.toLowerCase() ===
          telegramTo.toLowerCase(),
      )
    )
      return true;
  }
  return (
    await c.query(
      `select exists(select 1 from companies c where c.id=$1 and (c.status in ('refused','do_not_contact') or exists(select 1 from do_not_contact d where (d.company_id=c.id or (d.kind='company' and d.value_normalized=c.id::text)) or (d.kind='email' and d.value_normalized=lower($2)) or (d.kind='form' and d.value_normalized=$2) or (d.kind in ('phone','telegram','whatsapp') and d.value_normalized=$2) or (d.kind='domain' and d.value_normalized in (lower(split_part($2,'@',2)),lower(c.domain)))))) as blocked`,
      [companyId, address],
    )
  ).rows[0].blocked;
}
export async function getCompanyMessaging(companyId: string) {
  const [
    accounts,
    { rows: messages },
    { rows: campaigns },
    { rows: emails },
    { rows: analysis },
  ] = await Promise.all([
    listEmailAccounts(),
    sonarPool.query(
      `select m.id,m.channel,(m.screenshot_before is not null) as "screenshotBefore",(m.screenshot_after is not null) as "screenshotAfter",m.account_id as "accountId",m.to_value as "toAddress",m.subject,m.body,m.status,m.created_at as "createdAt",m.sent_at as "sentAt",m.scheduled_at as "scheduledAt",m.reason_uk as "reasonUk" from messages m join conversations c on c.id=m.conversation_id where c.company_id=$1 order by m.created_at desc,m.id`,
      [companyId],
    ),
    sonarPool.query(
      `select a.id,a.name,a.send_mode as "sendMode" from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=$1 order by cc.added_at desc,a.id`,
      [companyId],
    ),
    sonarPool.query(
      "select normalized from contacts where company_id=$1 and kind='email' order by rank desc,id",
      [companyId],
    ),
    sonarPool.query(
      'select result from analyses where company_id=$1 order by created_at desc,id desc limit 1',
      [companyId],
    ),
  ]);
  const { rows: whatsappContacts } = await sonarPool.query(
    `select ct.normalized,ct.meta,coalesce((select a.country_code from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=co.id order by cc.added_at desc,a.id limit 1),co.country_code) as country_code from contacts ct join companies co on co.id=ct.company_id where ct.company_id=$1 and ct.kind in ('whatsapp','phone') order by ct.rank desc,ct.id`,
    [companyId],
  );
  const recipients = emails.map((e) => String(e.normalized)).filter(validEmail);
  return {
    accounts,
    telegramAccounts: await listTelegramAccounts(),
    whatsappAccounts: await listWhatsAppAccounts(),
    whatsappRecipients: [
      ...new Set(
        whatsappContacts
          .filter((r) => !r.meta.whatsapp_unavailable)
          .map((r) => normalizeWhatsAppRecipient(r.normalized, r.country_code))
          .filter((v): v is string => !!v),
      ),
    ],
    whatsappUnavailable: whatsappContacts
      .filter((r) => r.meta.whatsapp_unavailable)
      .map((r) => ({
        value: String(r.normalized),
        reasonUk: String(r.meta.whatsapp_unavailable.reason_uk),
      })),
    telegramRecipients: [
      ...new Set(
        (
          await sonarPool.query(
            "select normalized from contacts where company_id=$1 and kind in ('telegram','phone') and not (meta ? 'telegram_unavailable') order by rank desc,id",
            [companyId],
          )
        ).rows
          .map((r) => normalizeTelegramRecipient(String(r.normalized)))
          .filter((v): v is string => !!v),
      ),
    ],
    telegramUnavailable: (
      await sonarPool.query(
        "select normalized as value,meta->'telegram_unavailable'->>'reason_uk' as \"reasonUk\" from contacts where company_id=$1 and meta ? 'telegram_unavailable' order by id",
        [companyId],
      )
    ).rows as { value: string; reasonUk: string }[],
    formAccounts: await listFormAccounts(),
    formUrls: (
      await sonarPool.query(
        "select normalized from contacts where company_id=$1 and kind='form' order by rank desc,id",
        [companyId],
      )
    ).rows.map((r) => String(r.normalized)),
    messages: messages as EmailMessage[],
    campaigns: campaigns as { id: string; name: string; sendMode: SendMode }[],
    emails: recipients,
    defaultRecipient: recipients[0] ?? '',
    blocked: await isContactBlocked(sonarPool, companyId, recipients[0]),
    campaignId: (campaigns[0]?.id ?? null) as string | null,
    sendMode: (campaigns[0]?.sendMode ?? 'approval') as SendMode,
    suggestedBody: String(analysis[0]?.result?.first_message ?? ''),
  };
}
type MessageInput = {
  channel?: 'email' | 'form' | 'telegram' | 'whatsapp';
  companyId: string;
  campaignId: string;
  accountId: string;
  toAddress: string;
  subject?: string;
  body: string;
  submit?: boolean;
  idempotencyKey: string;
};
async function queueMessage(c: PoolClient, id: string, companyId: string) {
  await c.query(
    'update messages set scheduled_at=coalesce(scheduled_at,now()) where id=$1',
    [id],
  );
  const taskId = await enqueueTask(
    'message.send',
    `message.send:${id}`,
    { messageId: id },
    c,
  );
  if (taskId)
    await c.query(
      "update tasks set subject_type='company',subject_id=$2 where id=$1",
      [taskId, companyId],
    );
}
export async function createCompanyMessage(
  input: MessageInput,
  userId: string | null,
  existing?: PoolClient,
) {
  const channel = input.channel ?? 'email';
  const country =
    channel === 'whatsapp'
      ? (
          await (existing ?? sonarPool).query(
            'select country_code from campaigns where id=$1',
            [input.campaignId],
          )
        ).rows[0]?.country_code
      : undefined;
  const to =
      channel === 'email'
        ? input.toAddress?.trim().toLowerCase()
        : channel === 'whatsapp'
          ? (normalizeWhatsAppRecipient(input.toAddress ?? '', country) ?? '')
          : channel === 'telegram'
            ? (normalizeTelegramRecipient(input.toAddress ?? '') ?? '')
            : input.toAddress?.trim(),
    subject = input.subject?.trim() ?? '',
    body = input.body?.trim();
  if (
    (channel === 'email'
      ? !validEmail(to) || !subject
      : channel === 'whatsapp'
        ? !normalizeWhatsAppRecipient(to, country)
        : channel === 'telegram'
          ? !normalizeTelegramRecipient(to)
          : !validFormUrl(to)) ||
    subject.length > 998 ||
    /[\r\n]/.test(subject) ||
    !body ||
    body.length > 100000 ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  )
    invalid(
      channel === 'whatsapp'
        ? 'Вкажіть міжнародний телефон WhatsApp та текст повідомлення.'
        : channel === 'telegram'
          ? 'Вкажіть Telegram username або міжнародний телефон та текст повідомлення.'
          : channel === 'form'
            ? 'Вкажіть коректну адресу форми та текст повідомлення.'
            : 'Вкажіть коректний email, тему та текст повідомлення.',
    );
  return transaction(async (c) => {
    const {
      rows: [prior],
    } = await c.query(
      'select m.*,v.company_id,v.campaign_id from messages m join conversations v on v.id=m.conversation_id where m.idempotency_key=$1',
      [input.idempotencyKey],
    );
    if (prior) {
      if (
        prior.channel !== channel ||
        prior.company_id !== input.companyId ||
        prior.campaign_id !== input.campaignId ||
        prior.account_id !== input.accountId ||
        prior.to_value !== to ||
        prior.subject !== subject ||
        prior.body !== body
      )
        invalid('Ключ повідомлення вже використано для іншого запиту.');
      return { id: String(prior.id), status: String(prior.status) };
    }
    const {
      rows: [campaign],
    } = await c.query(
      `select a.send_mode,a.channels from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=$1 and a.id=$2 for share of a`,
      [input.companyId, input.campaignId],
    );
    if (
      !campaign ||
      campaign.channels?.[channel === 'form' ? 'forms' : channel] !== true
    )
      invalid(
        'Канал у цій кампанії вимкнено або компанія не належить кампанії.',
      );
    if (await isContactBlocked(c, input.companyId, to, country))
      invalid('Компанія або адреса у списку «Не контактувати».');
    const {
      rows: [account],
    } = await c.query(
      "select id from channel_accounts where id=$1 and status='active' and channel=$2 for share",
      [input.accountId, channel],
    );
    if (!account) invalid('Оберіть активний акаунт каналу.');
    const contact =
      channel === 'whatsapp'
        ? (await whatsappContacts(c, input.companyId, to, country)).find(
            (r) => !r.meta.whatsapp_unavailable,
          )
        : channel === 'telegram'
          ? (await telegramContacts(c, input.companyId, to)).find(
              (r) => !r.meta.telegram_unavailable,
            )
          : (
              await c.query(
                'select id from contacts where company_id=$1 and kind=$3 and normalized=$2 for share',
                [input.companyId, to, channel],
              )
            ).rows[0];
    if (!contact) invalid('Оберіть адресу із контактів компанії.');
    if (channel === 'form') {
      const {
        rows: [company],
      } = await c.query('select website from companies where id=$1', [
        input.companyId,
      ]);
      if (!company?.website || !sameFormDomain(to, company.website))
        invalid('Форма повинна належати домену сайту компанії.');
    }
    const {
      rows: [conversation],
    } = await c.query(
      `insert into conversations(company_id,campaign_id,contact_id,channel) values($1,$2,$3,$4) on conflict(company_id,campaign_id,channel) do update set contact_id=excluded.contact_id returning id`,
      [input.companyId, input.campaignId, contact.id, channel],
    );
    const status = messageStatusForMode(
      campaign.send_mode,
      input.submit ?? false,
    );
    const {
      rows: [message],
    } = await c.query(
      `insert into messages(conversation_id,account_id,to_value,subject,body,status,idempotency_key,created_by,channel) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(idempotency_key) do update set idempotency_key=messages.idempotency_key returning *`,
      [
        conversation.id,
        input.accountId,
        to,
        subject,
        body,
        status,
        input.idempotencyKey,
        userId,
        channel,
      ],
    );
    if (message.status === 'queued')
      await queueMessage(c, message.id, input.companyId);
    await logActivity(
      'message.created',
      'company',
      input.companyId,
      userId,
      { messageId: message.id, status: message.status },
      c,
    );
    if (
      message.to_value !== undefined &&
      (message.conversation_id !== conversation.id ||
        message.account_id !== input.accountId ||
        message.to_value !== to ||
        message.subject !== subject ||
        message.body !== body)
    )
      invalid('Ключ повідомлення вже використано для іншого запиту.');
    return { id: String(message.id), status: String(message.status) };
  }, existing);
}
export async function submitMessage(messageId: string, userId: string) {
  return transaction(async (c) => {
    const {
      rows: [message],
    } = await c.query(
      `select m.id,m.status,m.channel,m.to_value,v.company_id,a.send_mode,a.channels from messages m join conversations v on v.id=m.conversation_id join campaigns a on a.id=v.campaign_id where m.id=$1 for update of m`,
      [messageId],
    );
    if (!message || message.status !== 'draft') return false;
    if (
      message.channels?.[
        message.channel === 'form' ? 'forms' : message.channel
      ] !== true ||
      (await isContactBlocked(c, message.company_id, message.to_value))
    )
      invalid('Канал вимкнено або компанія у списку «Не контактувати».');
    const status = messageStatusForMode(message.send_mode, true);
    await c.query(
      'update messages set status=$2,created_by=coalesce(created_by,$3) where id=$1',
      [messageId, status, userId],
    );
    if (status === 'queued')
      await queueMessage(c, messageId, message.company_id);
    await logActivity(
      'message.submitted',
      'company',
      message.company_id,
      userId,
      { messageId, status },
      c,
    );
    return true;
  });
}
export async function approveMessage(messageId: string, userId: string) {
  return transaction(async (c) => {
    const {
      rows: [message],
    } = await c.query(
      `update messages set status='queued',approved_by=$2,approved_at=now(),reason_uk=null where id=$1 and status='awaiting_approval' returning id,conversation_id,to_value`,
      [messageId, userId],
    );
    if (!message) return false;
    const {
      rows: [conversation],
    } = await c.query('select company_id from conversations where id=$1', [
      message.conversation_id,
    ]);
    if (await isContactBlocked(c, conversation.company_id, message.to_value))
      invalid('Компанія або адреса у списку «Не контактувати».');
    await queueMessage(c, message.id, conversation.company_id);
    await logActivity(
      'message.approved',
      'company',
      conversation.company_id,
      userId,
      { messageId },
      c,
    );
    return true;
  });
}
export async function blockCompany(companyId: string, userId: string) {
  await transaction(async (c) => {
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
      [companyId],
    );
    await c.query(
      "update companies set status='do_not_contact',updated_at=now() where id=$1",
      [companyId],
    );
    await c.query(
      "insert into do_not_contact(company_id,kind,value_normalized,reason,created_by) values($1::uuid,'company',$1::text,'Відмова від контакту',$2) on conflict(kind,value_normalized) do nothing",
      [companyId, userId],
    );
    await c.query(
      "update messages set status='failed',reason_uk='Компанія у списку «Не контактувати».' where conversation_id in (select id from conversations where company_id=$1) and status in ('draft','awaiting_approval','awaiting_manual','queued')",
      [companyId],
    );
    await logActivity('company.blocked', 'company', companyId, userId, {}, c);
  });
}
// Called inside the analysis transaction, so the draft and its queue job commit together.
export async function draftFromAnalysis(
  companyId: string,
  campaignId: string,
  analysisId: string,
  existing: PoolClient,
) {
  const {
    rows: [row],
  } = await existing.query(
    `select a.result,c.name,(select normalized from contacts where company_id=c.id and kind='email' order by rank desc,id limit 1) as email,(select id from channel_accounts where status='active' and channel='email' order by created_at,id limit 1) as account_id from analyses a join companies c on c.id=a.company_id where a.id=$1`,
    [analysisId],
  );
  if (
    !row ||
    row.result?.best_channel !== 'email' ||
    !row.result?.first_message?.trim() ||
    !validEmail(row.email ?? '') ||
    !row.account_id ||
    (await isContactBlocked(existing, companyId, row.email))
  )
    return;
  const {
    rows: [campaign],
  } = await existing.query(
    'select channels,status from campaigns where id=$1',
    [campaignId],
  );
  if (campaign?.channels?.email !== true || campaign.status !== 'active')
    return;
  await existing.query(
    "select pg_advisory_xact_lock(hashtextextended('first-message:'||$1::text||':'||$2::text,0))",
    [companyId, campaignId],
  );
  const { rows: prior } = await existing.query(
    'select id from messages where idempotency_key=$1',
    [`first-message:${companyId}:${campaignId}`],
  );
  if (prior.length) return;
  await createCompanyMessage(
    {
      companyId,
      campaignId,
      accountId: row.account_id,
      toAddress: row.email,
      subject: row.name,
      body: row.result.first_message,
      idempotencyKey: `first-message:${companyId}:${campaignId}`,
      submit: false,
    },
    null,
    existing,
  );
}

const whatsappRetry = 'Тимчасова помилка WhatsApp. Повтор після паузи акаунта.';
const telegramFloodRetry =
  'Telegram обмежив частоту. Повтор після паузи акаунта.';
const terminal = (
  status: 'skipped' | 'paused' | 'failed',
  reasonCode: string,
  reasonUk: string,
): TaskOutcome => ({ status, reasonCode, reasonUk });
const deferred = (
  runAt: Date,
  reasonCode: string,
  reasonUk: string,
): TaskOutcome => ({ status: 'deferred', runAt, reasonCode, reasonUk });
export type SendAccount = { id: string; settings: Record<string, unknown> };
export type ChannelSender = (
  request: EmailRequest,
  account?: SendAccount,
) => Promise<string>;
export async function sendEmailMessage(
  messageId: string,
  taskId: string,
  send: ChannelSender,
  now = new Date(),
  random = Math.random,
  channel: 'email' | 'telegram' | 'whatsapp' = 'email',
): Promise<TaskOutcome> {
  const c = await sonarPool.connect();
  let locked = false;
  let companyLocked = false;
  let accountLockId: string | undefined;
  let companyLockId: string | undefined;
  try {
    const {
      rows: [identity],
    } = await c.query(
      'select m.account_id,v.company_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1',
      [messageId],
    );
    if (!identity)
      return terminal(
        'skipped',
        'message_missing',
        'Повідомлення не знайдено.',
      );
    // Session lock spans the durable first-attempt commit and the provider call.
    await c.query(
      "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
      [identity.account_id],
    );
    locked = true;
    accountLockId = identity.account_id;
    companyLockId = identity.company_id;
    await c.query(
      "select pg_advisory_lock(hashtextextended('company-contact:'||$1::text,0))",
      [companyLockId],
    );
    companyLocked = true;
    await c.query('begin');
    const {
      rows: [m],
    } = await c.query(
      `select m.*,v.company_id,v.campaign_id,a.send_mode,a.channels,a.status as campaign_status,a.country_code from messages m join conversations v on v.id=m.conversation_id join campaigns a on a.id=v.campaign_id join companies co on co.id=v.company_id where m.id=$1 for update of m for share of a,co`,
      [messageId],
    );
    const finish = async (outcome: TaskOutcome, reason?: string) => {
      if (outcome.status === 'deferred')
        await c.query(
          "update messages set scheduled_at=$2,status='queued',reason_uk=$3 where id=$1",
          [
            messageId,
            outcome.runAt,
            channel === 'whatsapp' && m.reason_uk === whatsappRetry
              ? whatsappRetry
              : channel === 'telegram' && m.reason_uk === telegramFloodRetry
                ? telegramFloodRetry
                : outcome.reasonUk,
          ],
        );
      if (reason)
        await c.query(
          "update messages set status='failed',reason_uk=$2 where id=$1",
          [messageId, reason],
        );
      await c.query('commit');
      return outcome;
    };
    if (m.channel !== channel)
      return finish(
        terminal(
          'skipped',
          'channel_mismatch',
          'Повідомлення належить іншому каналу.',
        ),
      );
    if (['sent', 'delivered', 'read'].includes(m.status))
      return finish({
        status: 'done',
        result: { messageId, providerId: m.provider_id },
      });
    if (await isContactBlocked(c, m.company_id, m.to_value, m.country_code))
      return finish(
        terminal(
          'skipped',
          'do_not_contact',
          'Компанія або адреса у списку «Не контактувати».',
        ),
        'Компанія або адреса у списку «Не контактувати».',
      );
    const testBlocked = await testModeBlock(c, m.to_value, m.country_code);
    if (testBlocked)
      return finish(terminal('skipped', 'test_mode', testBlocked), testBlocked);
    if (channel === 'whatsapp') {
      const contacts = await whatsappContacts(
        c,
        m.company_id,
        m.to_value,
        m.country_code,
      );
      if (
        !contacts.length ||
        contacts.every((r) => r.meta.whatsapp_unavailable)
      )
        return finish(
          terminal(
            'skipped',
            'whatsapp_unavailable',
            'WhatsApp цього контакту недоступний.',
          ),
          'WhatsApp цього контакту недоступний.',
        );
      if (m.first_attempt_at && m.reason_uk !== whatsappRetry)
        return finish(
          terminal(
            'paused',
            'whatsapp_delivery_uncertain',
            'Перевірте попередню доставку WhatsApp вручну. Автоматичний повтор заблоковано.',
          ),
        );
    }
    if (channel === 'telegram') {
      const contacts = await telegramContacts(c, m.company_id, m.to_value);
      if (
        !contacts.length ||
        contacts.every((r) => r.meta.telegram_unavailable)
      )
        return finish(
          terminal(
            'skipped',
            'telegram_unavailable',
            'Telegram цього контакту недоступний.',
          ),
          'Telegram цього контакту недоступний.',
        );
      if (m.first_attempt_at && m.reason_uk !== telegramFloodRetry)
        return finish(
          terminal(
            'paused',
            'telegram_delivery_uncertain',
            'Перевірте попередню доставку Telegram вручну. Автоматичний повтор заблоковано.',
          ),
        );
    }
    if (m.status !== 'queued' && !(m.status === 'failed' && m.first_attempt_at))
      return finish(
        terminal(
          'skipped',
          'message_not_queued',
          'Повідомлення не готове до надсилання.',
        ),
      );
    if (m.channels?.[channel] !== true || m.campaign_status !== 'active')
      return finish(
        terminal(
          'paused',
          'campaign_inactive',
          `Активуйте кампанію та увімкніть ${channel === 'whatsapp' ? 'WhatsApp' : channel === 'telegram' ? 'Telegram' : 'email'} перед надсиланням.`,
        ),
      );
    if (m.send_mode === 'manual' && !m.created_by && !m.approved_by) {
      await c.query(
        "update messages set status='draft',reason_uk='Надішліть повідомлення вручну.' where id=$1",
        [messageId],
      );
      return finish(
        terminal(
          'paused',
          'manual_submission_required',
          'Надішліть повідомлення вручну.',
        ),
      );
    }
    if (m.send_mode === 'approval' && !m.approved_by) {
      await c.query(
        "update messages set status='awaiting_approval' where id=$1",
        [messageId],
      );
      return finish(
        terminal(
          'paused',
          'approval_required',
          'Повідомлення потребує схвалення.',
        ),
      );
    }
    const {
      rows: [account],
    } = await c.query('select * from channel_accounts where id=$1 for update', [
      m.account_id,
    ]);
    if (channel === 'telegram') {
      try {
        if (!process.env.AUTH_SECRET || !account.settings.sessionEncrypted)
          throw Error('session');
        decryptTelegramSession(
          account.settings.sessionEncrypted,
          process.env.AUTH_SECRET,
        );
      } catch {
        return finish(
          terminal(
            'paused',
            'telegram_session_invalid',
            'Сесія Telegram недійсна. Підключіть акаунт повторно.',
          ),
        );
      }
    }
    if (account.status !== 'active')
      return finish(
        terminal('paused', 'account_disabled', 'Акаунт каналу вимкнено.'),
      );
    if (
      channel === 'email' &&
      m.first_attempt_at &&
      now.getTime() - new Date(m.first_attempt_at).getTime() >=
        23 * 60 * 60 * 1000
    )
      return finish(
        terminal(
          'paused',
          'email_delivery_uncertain',
          'Минуло 23 години після першої спроби. Звірте доставку в Resend; автоматичний повтор заблоковано.',
        ),
        'Потрібно звірити доставку в Resend.',
      );
    const { rows: settings } = await c.query(
      "select key,value from settings where key like 'send.%'",
    );
    const config = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    const zone = config['send.time_zones']?.[m.country_code];
    let at: Date;
    const gapPrefix = channel === 'whatsapp' ? 'send.whatsapp' : 'send';
    const min = Number(config[`${gapPrefix}.min_gap_seconds`]),
      max = Number(config[`${gapPrefix}.max_gap_seconds`]);
    try {
      if (
        !zone ||
        !Number.isFinite(min) ||
        min < 0 ||
        !Number.isFinite(max) ||
        max < min
      )
        throw Error('config');
      at = nextSendTime(
        now,
        zone,
        config['send.hours'] as SendHours,
        account.next_send_at ?? undefined,
      );
    } catch {
      return finish(
        terminal(
          'paused',
          'send_settings_invalid',
          'Налаштуйте години, часовий пояс країни та інтервали надсилання.',
        ),
      );
    }
    if (at.getTime() > now.getTime())
      return finish(
        deferred(
          at,
          'outside_send_hours',
          'Надсилання заплановано на робочі години або після паузи акаунта.',
        ),
      );
    const day = now.toISOString().slice(0, 10);
    if (
      m.quota_day !== day &&
      account.sent_day === day &&
      account.attempt_count >= account.daily_limit
    ) {
      const tomorrow = new Date(`${day}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      return finish(
        deferred(
          nextSendTime(tomorrow, zone, config['send.hours'] as SendHours),
          'daily_limit',
          'Денний ліміт акаунта вичерпано. Надсилання перенесено.',
        ),
      );
    }
    const request: EmailRequest = m.request_snapshot ?? {
      from: account.address,
      to: m.to_value,
      subject: m.subject,
      body: m.body,
      idempotencyKey: m.idempotency_key,
    };
    if (!m.first_attempt_at) {
      await c.query(
        'update messages set first_attempt_at=$2,request_snapshot=$3,reason_uk=null where id=$1',
        [messageId, now, request],
      );
    }
    if (m.quota_day !== day)
      await c.query('update messages set quota_day=$2 where id=$1', [
        messageId,
        day,
      ]);
    const nextSendAt = new Date(
      now.getTime() + (min + Math.floor(random() * (max - min + 1))) * 1000,
    );
    await c.query(
      'update channel_accounts set sent_day=case when $4 then sent_day else $2 end,attempt_count=case when $4 then attempt_count when sent_day=$2 then attempt_count+1 else 1 end,next_send_at=$3 where id=$1',
      [account.id, day, nextSendAt, m.quota_day === day],
    );
    if (channel === 'telegram' || channel === 'whatsapp')
      await c.query('update messages set reason_uk=null where id=$1', [
        messageId,
      ]);
    await c.query('commit');
    const recordDelivery = async (
      providerId: string,
      reasonUk: string | null = null,
    ): Promise<TaskOutcome> => {
      await transaction(async (tx) => {
        await tx.query(
          "update messages set status='sent',provider_id=$2,sent_at=$3,reason_uk=$4 where id=$1",
          [messageId, providerId, now, reasonUk],
        );
        await tx.query(
          "update companies set status='contacted',updated_at=now() where id=$1 and status in ('new','enriching','ready')",
          [m.company_id],
        );
        await logActivity(
          'message.sent',
          'company',
          m.company_id,
          null,
          { messageId, providerId, taskId },
          tx,
        );
      });
      return { status: 'done', result: { messageId, providerId } };
    };
    try {
      const providerId =
        channel === 'telegram' || channel === 'whatsapp'
          ? await send(request, {
              id: account.id,
              settings: { ...account.settings, countryCode: m.country_code },
            })
          : await send(request);
      return await recordDelivery(providerId);
    } catch (error) {
      if (error instanceof WhatsAppSendError) {
        if (error.sessionInactive) {
          await transaction(async (tx) => {
            await tx.query(
              "update channel_accounts set status='paused',settings=settings || jsonb_build_object('reasonUk',$2::text) where id=$1",
              [account.id, error.reasonUk],
            );
            await tx.query(
              "update messages set status='queued',reason_uk=$2 where id=$1",
              [messageId, whatsappRetry],
            );
          });
          return terminal('paused', error.code, error.reasonUk);
        }
        if (error.unavailable) {
          const contacts = await whatsappContacts(
            c,
            m.company_id,
            m.to_value,
            m.country_code,
          );
          await c.query(
            "update contacts set meta=jsonb_set(meta,'{whatsapp_unavailable}',$2::jsonb) where id=any($1::uuid[])",
            [
              contacts.map((r) => r.id),
              JSON.stringify({
                reason_uk: error.reasonUk,
                at: now.toISOString(),
              }),
            ],
          );
          await c.query(
            "update messages set status='failed',reason_uk=$2 where id=$1",
            [messageId, error.reasonUk],
          );
          return terminal('skipped', error.code, error.reasonUk);
        }
        if (error.retryable) {
          // Provider HTTP failures retry; ambiguous transport failures pause.
          const runAt = new Date(
            Math.max(
              nextSendAt.getTime(),
              now.getTime() + (error.retryAfterSeconds ?? min) * 1000,
              now.getTime() + min * 1000,
            ),
          );
          await transaction(async (tx) => {
            await tx.query(
              'update channel_accounts set next_send_at=$2 where id=$1',
              [account.id, runAt],
            );
            await tx.query(
              "update messages set status='queued',scheduled_at=$2,reason_uk=$3 where id=$1",
              [messageId, runAt, whatsappRetry],
            );
          });
          return deferred(runAt, error.code, error.reasonUk);
        }
        await c.query(
          "update messages set status='failed',reason_uk=$2 where id=$1",
          [messageId, error.reasonUk],
        );
        return terminal(
          error.code === 'send_ambiguous' ? 'paused' : 'failed',
          error.code,
          error.reasonUk,
        );
      }
      if (error instanceof TelegramSendError) {
        const accountRetryAfterSeconds =
          'accountRetryAfterSeconds' in error
            ? error.accountRetryAfterSeconds
            : undefined;
        if (
          typeof accountRetryAfterSeconds === 'number' &&
          Number.isFinite(accountRetryAfterSeconds) &&
          accountRetryAfterSeconds > 0
        )
          await c.query(
            'update channel_accounts set next_send_at=greatest(next_send_at,$2::timestamptz) where id=$1',
            [
              account.id,
              new Date(now.getTime() + accountRetryAfterSeconds * 1000),
            ],
          );
        if (
          'providerMessageId' in error &&
          typeof error.providerMessageId === 'string'
        )
          return recordDelivery(error.providerMessageId, error.reasonUk);
        if (error.retryAfterSeconds !== undefined) {
          const runAt = new Date(
            now.getTime() + error.retryAfterSeconds * 1000,
          );
          await transaction(async (tx) => {
            await tx.query(
              'update channel_accounts set next_send_at=$2 where id=$1',
              [account.id, runAt],
            );
            await tx.query(
              "update messages set status='queued',scheduled_at=$2,reason_uk=$3 where id=$1",
              [messageId, runAt, telegramFloodRetry],
            );
          });
          return deferred(runAt, error.code, error.reasonUk);
        }
        if (error.unavailable) {
          const contacts = await telegramContacts(c, m.company_id, m.to_value);
          await c.query(
            "update contacts set meta=jsonb_set(meta,'{telegram_unavailable}',$2::jsonb) where id=any($1::uuid[])",
            [
              contacts.map((r) => r.id),
              JSON.stringify({
                reason_uk: error.reasonUk,
                at: now.toISOString(),
              }),
            ],
          );
        }
        await c.query(
          "update messages set status='failed',reason_uk=$2 where id=$1",
          [messageId, error.reasonUk],
        );
        if (!error.retryable)
          return terminal(
            ['session_expired', 'delivery_uncertain'].includes(error.code)
              ? 'paused'
              : 'failed',
            error.code,
            error.reasonUk,
          );
        return terminal(
          'paused',
          'telegram_delivery_uncertain',
          'Перевірте попередню доставку Telegram вручну. Автоматичний повтор заблоковано.',
        );
      }
      const reason =
        error instanceof EmailSendError
          ? error.reasonUk
          : channel === 'whatsapp'
            ? 'Не вдалося підтвердити доставку WhatsApp. Перевірте доставку вручну; автоматичний повтор заблоковано.'
            : channel === 'telegram'
              ? 'Не вдалося підтвердити доставку Telegram. Повтор використає той самий ключ.'
              : 'Не вдалося підтвердити доставку email. Повтор використає той самий ключ Resend.';
      await c.query(
        "update messages set status='failed',reason_uk=$2 where id=$1",
        [messageId, reason],
      );
      if (error instanceof EmailSendError && !error.retryable)
        return terminal('failed', error.code, reason);
      if (channel === 'whatsapp')
        return terminal('paused', 'whatsapp_delivery_uncertain', reason);
      if (channel === 'telegram')
        return terminal('paused', 'telegram_delivery_uncertain', reason);
      throw new TaskFailure(
        error instanceof EmailSendError
          ? error.code
          : 'email_delivery_uncertain',
        reason,
      );
    }
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    if (companyLocked)
      await c.query(
        "select pg_advisory_unlock(hashtextextended('company-contact:'||$1::text,0))",
        [companyLockId],
      );
    if (locked)
      await c.query(
        "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
        [accountLockId],
      );
    c.release();
  }
}

export const validFormUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return (
      ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
    );
  } catch {
    return false;
  }
};
export const sameFormDomain = (value: string, website: string): boolean => {
  try {
    return (
      validFormUrl(value) &&
      validFormUrl(website) &&
      new URL(value).hostname.toLowerCase().replace(/^www\./, '') ===
        new URL(website).hostname.toLowerCase().replace(/^www\./, '')
    );
  } catch {
    return false;
  }
};
export interface FormAccount extends EmailAccount {
  senderName: string;
  senderPhone: string;
}
type FormAccountInput = {
  name: string;
  fromAddress: string;
  senderName: string;
  senderPhone: string;
  dailyLimit: number;
};
export async function listFormAccounts(): Promise<FormAccount[]> {
  return (
    await sonarPool.query(
      `select a.id,a.name,a.address as "fromAddress",a.settings->>'senderName' as "senderName",a.settings->>'senderPhone' as "senderPhone",a.daily_limit as "dailyLimit",(a.status='active') as enabled,a.next_send_at as "nextSendAt",u.name as "ownerName",(select count(*)::int from messages m where m.account_id=a.id and m.sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday" from channel_accounts a left join users u on u.id=a.owner_id where a.channel='form' order by a.name,a.id`,
    )
  ).rows;
}
function formAccountValues(input: FormAccountInput) {
  const name = input.name?.trim(),
    address = input.fromAddress?.trim().toLowerCase(),
    senderName = input.senderName?.trim(),
    senderPhone = input.senderPhone?.trim()
      ? normalizePhone(input.senderPhone.trim(), 'UA')
      : '';
  if (
    !name ||
    name.length > 200 ||
    !validEmail(address) ||
    !senderName ||
    senderName.length > 200 ||
    (input.senderPhone?.trim() &&
      (!senderPhone || !input.senderPhone.trim().startsWith('+'))) ||
    !Number.isInteger(input.dailyLimit) ||
    input.dailyLimit < 1 ||
    input.dailyLimit > 100000
  )
    invalid(
      'Вкажіть назву, ім’я, email та додатний денний ліміт. Телефон, якщо вказано, має бути міжнародним.',
    );
  return [
    name,
    address,
    input.dailyLimit,
    JSON.stringify({ senderName, senderPhone }),
  ];
}
export async function createFormAccount(
  input: FormAccountInput,
  userId: string,
) {
  const values = formAccountValues(input);
  return transaction(async (c) => {
    const {
      rows: [account],
    } = await c.query(
      "insert into channel_accounts(name,address,daily_limit,settings,owner_id,channel) values($1,$2,$3,$4,$5,'form') returning id",
      [...values, userId],
    );
    await logActivity(
      'form.account.created',
      'channel_account',
      account.id,
      userId,
      {},
      c,
    );
    return { id: String(account.id) };
  });
}
export async function updateFormAccount(
  id: string,
  input: FormAccountInput,
  userId: string,
) {
  const values = formAccountValues(input);
  return transaction(async (c) => {
    const { rowCount } = await c.query(
      "update channel_accounts set name=$1,address=$2,daily_limit=$3,settings=$4 where id=$5 and channel='form'",
      [...values, id],
    );
    if (rowCount)
      await logActivity(
        'form.account.updated',
        'channel_account',
        id,
        userId,
        {},
        c,
      );
    return !!rowCount;
  });
}
