import {
  nextSendTime,
  normalizePhone,
  sharedFormContactsFromValues,
  type SharedFormContact,
  type SendHours,
} from '@sonar/core';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';
import {
  EmailValidationError,
  isContactBlocked,
  sameFormDomain,
  transaction,
  ensureFormAccount,
  validFormUrl,
} from './email.js';
import { logActivity, type TaskOutcome } from './tasks.js';

export type ContactDetails = {
  name: string;
  email: string;
  phone: string;
  whatsapp: string;
  telegram: string;
  website: string;
};
const contactFields = [
  'name',
  'email',
  'phone',
  'whatsapp',
  'telegram',
  'website',
] as const;
async function loadContactDetails(
  c: Pick<PoolClient, 'query'>,
): Promise<ContactDetails> {
  const { rows } = await c.query(
    "select key,value from settings where key like 'contact.%'",
  );
  const values = Object.fromEntries(
    rows.map((r) => [r.key, typeof r.value === 'string' ? r.value.trim() : '']),
  );
  const { rows: accounts } = await c.query(
    "select channel,address from channel_accounts where (channel='email' and status='active') or (channel='whatsapp' and status='active' and settings->>'providerStatus'='WORKING') order by created_at,id",
  );
  return Object.fromEntries(
    contactFields.map((key) => [
      key,
      values[`contact.${key}`] ||
        (key === 'email'
          ? accounts.find((a) => a.channel === 'email')?.address
          : key === 'whatsapp'
            ? accounts.find((a) => a.channel === 'whatsapp')?.address
            : '') ||
        '',
    ]),
  ) as ContactDetails;
}
export async function getContactDetails(): Promise<ContactDetails> {
  return loadContactDetails(sonarPool);
}
export async function getFormDeliverySettings(): Promise<{
  dailyLimit: number;
  sentToday: number;
}> {
  const {
    rows: [row],
  } = await sonarPool.query(
    `select coalesce((select daily_limit from channel_accounts where channel='form' order by created_at,id limit 1), (select (value #>> '{}')::int from settings where key='send.form_company_daily_limit'), 1) as "dailyLimit",
      (select count(*)::int from messages where channel='form' and direction='out' and sent_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') as "sentToday"`,
  );
  return {
    dailyLimit: Number(row.dailyLimit),
    sentToday: Number(row.sentToday),
  };
}
export async function saveContactDetails(
  input: ContactDetails,
  userId: string,
  dailyLimit?: number,
): Promise<void> {
  const values = Object.fromEntries(
    contactFields.map((key) => [
      key,
      typeof input[key] === 'string' ? input[key].trim() : '',
    ]),
  ) as ContactDetails;
  if (
    values.name.length > 200 ||
    (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) ||
    (values.website && !validFormUrl(values.website)) ||
    Object.values(values).some((v) => v.length > 2000)
  )
    throw new EmailValidationError('Перевірте ім’я, email та адресу сайту.');
  if (
    dailyLimit !== undefined &&
    (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100000)
  )
    throw new EmailValidationError(
      'Ліміт має бути цілим числом від 1 до 100000.',
    );
  for (const key of ['phone', 'whatsapp'] as const) {
    if (!values[key]) continue;
    const phone = values[key].startsWith('+') && normalizePhone(values[key]);
    if (!phone)
      throw new EmailValidationError(
        'Телефон і WhatsApp мають бути міжнародними номерами.',
      );
    values[key] = phone;
  }
  await transaction(async (c) => {
    if (dailyLimit !== undefined) {
      await ensureFormAccount(c);
      await c.query(
        "update channel_accounts set daily_limit=$1 where channel='form'",
        [dailyLimit],
      );
    }
    for (const key of contactFields)
      await c.query(
        'insert into settings(key,value) values($1,$2::jsonb) on conflict(key) do update set value=excluded.value',
        [`contact.${key}`, JSON.stringify(values[key])],
      );
    await logActivity(
      'contact.details.updated',
      'settings',
      null,
      userId,
      {},
      c,
    );
  });
}

export type FormRequest = {
  messageId: string;
  companyId: string;
  campaignId: string;
  url: string;
  website: string;
  name: string;
  email: string;
  phone: string;
  whatsapp: string;
  telegram: string;
  senderWebsite: string;
  body: string;
  sharedContacts: SharedFormContact[];
  captcha?: string;
};
export type FormResult = {
  status: 'sent' | 'awaiting_manual' | 'failed' | 'skipped';
  reasonUk?: string;
  reasonCode?: string;
  evidence?: string;
};
export type FormControls = {
  onFilled: (snapshot: {
    body: string;
    sharedContacts: SharedFormContact[];
  }) => Promise<void>;
  beforeSubmit: () => Promise<void>;
  saveScreenshot: (phase: 'before' | 'after', bytes: Buffer) => Promise<void>;
};
export type FormSender = (
  request: FormRequest,
  controls: FormControls,
) => Promise<FormResult>;
const manualReason =
  'Результат попередньої спроби невідомий. Перевірте форму вручну; автоматичний повтор заблоковано.';
class FormGuard extends Error {
  constructor(public outcome: TaskOutcome) {
    super('form_guard');
  }
}
const stop = (
  status: 'skipped' | 'paused' | 'failed',
  reasonCode: string,
  reasonUk: string,
): TaskOutcome => ({ status, reasonCode, reasonUk });

export async function sendFormMessage(
  messageId: string,
  taskId: string,
  send: FormSender,
  now = new Date(),
): Promise<TaskOutcome> {
  const startedAt = Date.now(),
    referenceNow = now.getTime();
  const c = await sonarPool.connect();
  let accountId: string | undefined,
    companyId: string | undefined,
    attempted = false;
  try {
    const {
      rows: [identity],
    } = await c.query(
      "select m.account_id,v.company_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1 and m.channel='form'",
      [messageId],
    );
    if (!identity)
      return stop(
        'skipped',
        'message_missing',
        'Повідомлення форми не знайдено.',
      );
    if (!identity.account_id) {
      await c.query('begin');
      try {
        const ensured = await ensureFormAccount(c);
        await c.query(
          'update messages set account_id=$2 where id=$1 and account_id is null',
          [messageId, ensured.id],
        );
        await c.query('commit');
        identity.account_id = ensured.id;
      } catch (error) {
        await c.query('rollback');
        throw error;
      }
    }
    await c.query(
      "select pg_advisory_lock(hashtextextended('channel-account:'||$1::text,0))",
      [identity.account_id],
    );
    accountId = identity.account_id;
    await c.query(
      "select pg_advisory_lock(hashtextextended('company-contact:'||$1::text,0))",
      [identity.company_id],
    );
    companyId = identity.company_id;
    const {
      rows: [m],
    } = await c.query(
      `select m.*,v.company_id,v.campaign_id,a.channels,a.send_mode,a.status as campaign_status,a.country_code,co.website from messages m join conversations v on v.id=m.conversation_id join campaigns a on a.id=v.campaign_id join companies co on co.id=v.company_id where m.id=$1`,
      [messageId],
    );
    if (['sent', 'delivered', 'read'].includes(m.status))
      return { status: 'done', result: { messageId } };
    if (await isContactBlocked(c, m.company_id, m.to_value)) {
      const reason = 'Компанія або форма у списку «Не контактувати».';
      await c.query(
        "update messages set status='failed',reason_uk=$2 where id=$1",
        [messageId, reason],
      );
      return stop('skipped', 'do_not_contact', reason);
    }
    if (m.first_attempt_at || m.status === 'awaiting_manual') {
      await c.query(
        "update messages set status='awaiting_manual',reason_uk=coalesce(reason_uk,$2) where id=$1",
        [messageId, manualReason],
      );
      return stop('paused', 'form_manual_required', manualReason);
    }
    const details = await loadContactDetails(c);
    const { rows: settings } = await c.query(
      "select key,value from settings where key like 'send.%'",
    );
    const config = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    let day = now.toISOString().slice(0, 10);
    const zone = config['send.time_zones']?.[m.country_code];
    const min = Number(config['send.min_gap_seconds']),
      max = Number(config['send.max_gap_seconds']),
      cap = Number(config['send.form_company_daily_limit']);
    const guard = async (): Promise<TaskOutcome | undefined> => {
      if (await isContactBlocked(c, m.company_id, m.to_value))
        return stop(
          'skipped',
          'do_not_contact',
          'Компанія або форма у списку «Не контактувати».',
        );
      if (m.status !== 'queued')
        return stop(
          'skipped',
          'message_not_queued',
          'Повідомлення не готове до надсилання.',
        );
      const {
        rows: [live],
      } = await c.query(
        'select a.status,a.channels,a.send_mode,co.website from campaigns a join companies co on co.id=$2 where a.id=$1',
        [m.campaign_id, m.company_id],
      );
      if (live?.status !== 'active' || live.channels?.forms !== true)
        return stop(
          'paused',
          'campaign_inactive',
          'Активуйте кампанію та увімкніть форми перед надсиланням.',
        );
      if (live.send_mode === 'approval' && !m.approved_by)
        return stop(
          'paused',
          'approval_required',
          'Повідомлення потребує схвалення.',
        );
      if (live.send_mode === 'manual' && !m.created_by && !m.approved_by)
        return stop(
          'paused',
          'manual_submission_required',
          'Надішліть повідомлення вручну.',
        );
      const {
        rows: [active],
      } = await c.query(
        "select status,daily_limit,sent_day,attempt_count,next_send_at from channel_accounts where id=$1 and channel='form'",
        [accountId],
      );
      if (active?.status !== 'active')
        return stop('paused', 'account_disabled', 'Надсилання форм вимкнено.');
      const {
        rows: [contact],
      } = await c.query(
        "select id from contacts where company_id=$1 and kind='form' and normalized=$2",
        [m.company_id, m.to_value],
      );
      if (!contact || !sameFormDomain(m.to_value, live.website ?? ''))
        return stop(
          'skipped',
          'form_domain',
          'Оберіть знайдену форму на домені сайту компанії.',
        );
      try {
        if (
          !zone ||
          !Number.isFinite(min) ||
          min < 0 ||
          !Number.isFinite(max) ||
          max < min ||
          !Number.isInteger(cap) ||
          cap < 1
        )
          throw Error('config');
        const at = nextSendTime(
          now,
          zone,
          config['send.hours'] as SendHours,
          active.next_send_at ?? undefined,
        );
        if (at > now)
          return {
            status: 'deferred',
            runAt: at,
            reasonCode: 'outside_send_hours',
            reasonUk:
              'Надсилання заплановано на робочі години або після паузи акаунта.',
          };
        const {
          rows: [count],
        } = await c.query(
          "select count(*)::int as n from messages m join conversations v on v.id=m.conversation_id where v.company_id=$1 and m.channel='form' and m.quota_day=$2",
          [companyId, day],
        );
        if (
          (active.sent_day === day &&
            active.attempt_count >= active.daily_limit) ||
          count.n >= cap
        ) {
          const tomorrow = new Date(`${day}T00:00:00Z`);
          tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
          return {
            status: 'deferred',
            runAt: nextSendTime(
              tomorrow,
              zone,
              config['send.hours'] as SendHours,
            ),
            reasonCode: count.n >= cap ? 'company_daily_limit' : 'daily_limit',
            reasonUk: 'Денний ліміт форм вичерпано. Надсилання перенесено.',
          };
        }
      } catch {
        return stop(
          'paused',
          'send_settings_invalid',
          'Налаштуйте години, часовий пояс країни та ліміти надсилання форм.',
        );
      }
    };
    const recordGuard = async (outcome: TaskOutcome) => {
      if (outcome.status === 'deferred')
        await c.query(
          'update messages set scheduled_at=$2,reason_uk=$3 where id=$1',
          [messageId, outcome.runAt, outcome.reasonUk],
        );
      if (outcome.status !== 'done' && outcome.status !== 'deferred')
        await c.query('update messages set reason_uk=$2 where id=$1', [
          messageId,
          outcome.reasonUk,
        ]);
      if (
        outcome.status === 'skipped' &&
        outcome.reasonCode === 'do_not_contact'
      )
        await c.query(
          "update messages set status='failed',reason_uk=$2 where id=$1",
          [messageId, outcome.reasonUk],
        );
      return outcome;
    };
    const gate = await guard();
    if (gate) return recordGuard(gate);
    const {
      rows: [contact],
    } = await c.query(
      "select meta from contacts where company_id=$1 and kind='form' and normalized=$2 limit 1",
      [companyId, m.to_value],
    );
    const request: FormRequest = {
      messageId,
      companyId: m.company_id,
      campaignId: m.campaign_id,
      url: m.to_value,
      website: m.website,
      name: details.name,
      email: details.email,
      phone: details.phone,
      whatsapp: details.whatsapp,
      telegram: details.telegram,
      senderWebsite: details.website,
      body: m.body,
      sharedContacts: [],
      captcha: contact?.meta?.captcha,
    };
    await c.query(
      'update messages set request_snapshot=$2 where id=$1 and first_attempt_at is null',
      [messageId, request],
    );
    const controls: FormControls = {
      onFilled: async (snapshot) => {
        request.body = snapshot.body;
        request.sharedContacts = snapshot.sharedContacts;
        await c.query(
          'update messages set request_snapshot=$2 where id=$1 and first_attempt_at is null',
          [messageId, request],
        );
      },
      saveScreenshot: async (phase, bytes) => {
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10000000)
          throw Error('Invalid screenshot');
        await c.query(
          `update messages set ${phase === 'before' ? 'screenshot_before' : 'screenshot_after'}=$2 where id=$1`,
          [messageId, bytes],
        );
      },
      beforeSubmit: async () => {
        now = new Date(referenceNow + Date.now() - startedAt);
        day = now.toISOString().slice(0, 10);
        if (attempted)
          throw new FormGuard(
            stop('paused', 'form_manual_required', manualReason),
          );
        await c.query('begin');
        try {
          const gate = await guard();
          if (gate) throw new FormGuard(gate);
          const {
            rows: [evidence],
          } = await c.query(
            'select screenshot_before from messages where id=$1',
            [messageId],
          );
          if (!evidence?.screenshot_before)
            throw new FormGuard(
              stop(
                'paused',
                'form_screenshot_required',
                'Збережіть знімок форми перед надсиланням.',
              ),
            );
          const {
            rows: [claimed],
          } = await c.query(
            'update messages set first_attempt_at=$2,quota_day=$3,request_snapshot=$4,reason_uk=null where id=$1 and first_attempt_at is null returning id',
            [messageId, now, day, request],
          );
          if (!claimed)
            throw new FormGuard(
              stop('paused', 'form_manual_required', manualReason),
            );
          await c.query(
            'update channel_accounts set sent_day=$2,attempt_count=case when sent_day=$2 then attempt_count+1 else 1 end,next_send_at=$3 where id=$1',
            [
              accountId,
              day,
              new Date(
                now.getTime() +
                  (min + Math.floor(Math.random() * (max - min + 1))) * 1000,
              ),
            ],
          );
          await c.query('commit');
          attempted = true;
        } catch (error) {
          await c.query('rollback');
          throw error;
        }
      },
    };
    let result: FormResult;
    try {
      result = await send(request, controls);
    } catch (error) {
      if (error instanceof FormGuard) return recordGuard(error.outcome);
      result = {
        status: 'awaiting_manual',
        reasonUk: attempted
          ? manualReason
          : 'Не вдалося обробити форму. Перевірте її вручну.',
      };
    }
    if (result.status === 'sent' && !attempted)
      result = {
        status: 'awaiting_manual',
        reasonUk: 'Не зафіксовано спробу надсилання. Перевірте форму вручну.',
      };
    if (attempted && result.status !== 'sent')
      result = {
        ...result,
        status: 'awaiting_manual',
        reasonUk: result.reasonUk ?? manualReason,
      };
    const reason =
      result.status === 'sent'
        ? null
        : (result.reasonUk ?? 'Потрібна ручна перевірка форми.');
    await transaction(async (tx) => {
      await tx.query(
        'update messages set status=$2,reason_uk=$3,sent_at=$4 where id=$1',
        [
          messageId,
          result.status === 'skipped' ? 'failed' : result.status,
          reason,
          result.status === 'sent' ? now : null,
        ],
      );
      if (result.status === 'sent')
        await tx.query(
          "update companies set status='contacted',updated_at=now() where id=$1 and status in ('new','enriching','ready')",
          [companyId],
        );
      await logActivity(
        result.status === 'sent' ? 'message.sent' : 'form.manual_required',
        'company',
        m.company_id,
        null,
        { messageId, taskId, evidence: result.evidence, reasonUk: reason },
        tx,
      );
    });
    return result.status === 'sent'
      ? { status: 'done', result: { messageId, evidence: result.evidence } }
      : stop(
          result.status === 'awaiting_manual' ? 'paused' : result.status,
          result.reasonCode ?? 'form_manual_required',
          reason!,
        );
  } finally {
    if (companyId)
      await c.query(
        "select pg_advisory_unlock(hashtextextended('company-contact:'||$1::text,0))",
        [companyId],
      );
    if (accountId)
      await c.query(
        "select pg_advisory_unlock(hashtextextended('channel-account:'||$1::text,0))",
        [accountId],
      );
    c.release();
  }
}

export type FormInboxStatus =
  | 'awaiting_manual'
  | 'sent'
  | 'replied'
  | 'awaiting_approval'
  | 'queued'
  | 'draft'
  | 'failed';
export type FormInboxReply = {
  id: string;
  companyName: string;
  contactValue: string | null;
  channel: string;
  lastMessage: string;
  lastAt: string;
};
export type FormInboxMessage = {
  id: string;
  companyId: string;
  companyName: string;
  conversationId: string;
  url: string;
  body: string;
  status: Exclude<FormInboxStatus, 'replied'> | 'delivered' | 'read';
  createdAt: Date;
  sentAt: Date | null;
  reasonUk: string | null;
  senderName: string;
  senderEmail: string;
  senderPhone: string;
  senderWhatsapp: string;
  senderTelegram: string;
  senderWebsite: string;
  sharedContacts: SharedFormContact[];
  screenshotBefore: boolean;
  screenshotAfter: boolean;
  replyConversations: FormInboxReply[];
  replies: number;
};
export async function listFormMessages(
  options: { status?: FormInboxStatus } = {},
): Promise<FormInboxMessage[]> {
  const { rows } = await sonarPool.query<
    Omit<FormInboxMessage, 'sharedContacts'> & {
      savedSharedContacts: SharedFormContact[] | null;
    }
  >(
    `select m.id,v.company_id as "companyId",co.name as "companyName",v.id as "conversationId",m.to_value as url,
      coalesce(m.request_snapshot->>'body',m.body) as body,m.status,m.created_at as "createdAt",m.sent_at as "sentAt",m.reason_uk as "reasonUk",
      coalesce(m.request_snapshot->>'name','') as "senderName",coalesce(m.request_snapshot->>'email','') as "senderEmail",coalesce(m.request_snapshot->>'phone','') as "senderPhone",
      coalesce(m.request_snapshot->>'whatsapp','') as "senderWhatsapp",coalesce(m.request_snapshot->>'telegram','') as "senderTelegram",coalesce(m.request_snapshot->>'senderWebsite','') as "senderWebsite",
      m.request_snapshot->'sharedContacts' as "savedSharedContacts",
      (m.screenshot_before is not null) as "screenshotBefore",(m.screenshot_after is not null) as "screenshotAfter",
      coalesce(replies.items,'[]'::jsonb) as "replyConversations",coalesce(replies.n,0)::int as replies
     from messages m join conversations v on v.id=m.conversation_id join companies co on co.id=v.company_id
     left join lateral (
       select jsonb_agg(jsonb_build_object('id',r.id,'companyName',co.name,'contactValue',r.peer_value,'channel',r.channel,'lastMessage',latest.body,'lastAt',latest.created_at) order by latest.created_at desc) as items,sum(latest.n) as n
       from conversations r join lateral (select body,created_at,count(*) over() as n from messages where conversation_id=r.id and direction='in' order by created_at desc,id desc limit 1) latest on true
       where r.form_reply_match->>'state'='bound' and r.form_reply_match->>'formMessageId'=m.id::text
     ) replies on true
     where m.channel='form' and m.direction='out' and ($1::text is null or ($1='replied' and replies.n>0) or ($1<>'replied' and m.status=$1)) order by m.created_at desc,m.id desc`,
    [options.status ?? null],
  );
  return rows.map((row) => ({
    ...row,
    sharedContacts: sharedFormContactsFromValues(
      {
        email: row.senderEmail,
        phone: row.senderPhone,
        whatsapp: row.senderWhatsapp,
        telegram: row.senderTelegram,
      },
      row.savedSharedContacts,
    ),
  }));
}
export async function listManualFormMessages() {
  return listFormMessages({ status: 'awaiting_manual' });
}
export async function getFormScreenshot(
  messageId: string,
  phase: 'before' | 'after',
): Promise<Buffer | null> {
  return (
    (
      await sonarPool.query(
        `select ${phase === 'before' ? 'screenshot_before' : 'screenshot_after'} as bytes from messages where id=$1 and channel='form'`,
        [messageId],
      )
    ).rows[0]?.bytes ?? null
  );
}
export async function markFormMessageSent(
  messageId: string,
  userId: string,
): Promise<boolean> {
  return transaction(async (c) => {
    const {
      rows: [identity],
    } = await c.query(
      "select m.account_id,v.company_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1 and m.channel='form'",
      [messageId],
    );
    if (!identity) return false;
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
      [identity.account_id],
    );
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
      [identity.company_id],
    );
    const {
      rows: [m],
    } = await c.query(
      "select * from messages where id=$1 and status='awaiting_manual' for update",
      [messageId],
    );
    if (!m) return false;
    const day = new Date().toISOString().slice(0, 10);
    await c.query(
      "update messages set status='sent',sent_at=now(),reason_uk=null,quota_day=coalesce(quota_day,$2) where id=$1",
      [messageId, day],
    );
    if (!m.quota_day)
      await c.query(
        'update channel_accounts set sent_day=$2,attempt_count=case when sent_day=$2 then attempt_count+1 else 1 end where id=$1',
        [identity.account_id, day],
      );
    await c.query(
      "update companies set status='contacted',updated_at=now() where id=$1 and status in ('new','enriching','ready')",
      [identity.company_id],
    );
    await c.query(
      "update tasks set status='done',finished_at=now(),reason_code=null,reason_uk=null,result=coalesce(result,'{}'::jsonb)||$2::jsonb where type='message.send' and payload->>'messageId'=$1 and status='paused' and coalesce(result->>'billingPending','false')<>'true'",
      [messageId, { messageId, manuallySent: true }],
    );
    await logActivity(
      'form.manually_sent',
      'company',
      identity.company_id,
      userId,
      { messageId },
      c,
    );
    return true;
  });
}
