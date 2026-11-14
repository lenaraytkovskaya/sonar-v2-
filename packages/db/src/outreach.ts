import type { PoolClient } from 'pg';
import { selectOutreachContacts } from '@sonar/core';
import { sonarPool } from './index.js';
import {
  EmailValidationError,
  isContactBlocked,
  transaction,
} from './email.js';
import { enqueueTask, logActivity } from './tasks.js';

export interface OutreachContact {
  id: string;
  kind: string;
  value: string;
  normalized: string;
  rank: number;
  meta: Record<string, unknown>;
}
export interface OutreachMessage {
  id: string;
  conversationId: string;
  channel: string;
  direction: string;
  source: string;
  subject: string;
  body: string;
  status: string;
  toValue: string;
  reasonUk: string | null;
  providerId?: string | null;
  classification: string | null;
  needsHuman: boolean;
  readAt: Date | null;
  createdAt: Date;
  sentAt: Date | null;
}
export interface OutreachConversation {
  id: string;
  companyId: string | null;
  companyName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  contactId: string | null;
  contactValue: string;
  unreadCount: number;
  needsHuman: boolean;
  campaignSendMode: string;
  channel: string;
  status: string;
  lastMessage: string | null;
  lastStatus: string | null;
  lastReasonUk?: string | null;
  lastAt: Date | null;
}
export interface DraftInput {
  companyId: string;
  campaignId: string;
  analysisId: string;
  contactId: string;
  version: string;
}
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
const editable = ['draft', 'awaiting_approval', 'awaiting_manual'];
const automatic = ['email', 'telegram', 'whatsapp'];
const conversationSelect = `select v.id,v.company_id as "companyId",co.name as "companyName",v.campaign_id as "campaignId",a.name as "campaignName",v.contact_id as "contactId",coalesce(ct.value,v.peer_value,m.to_value,'') as "contactValue",v.channel,v.status,m.body as "lastMessage",m.status as "lastStatus",m.reason_uk as "lastReasonUk",m.created_at as "lastAt",coalesce(a.send_mode,'manual') as "campaignSendMode",
  (select count(*)::int from messages where conversation_id=v.id and direction='in' and read_at is null) as "unreadCount",
  exists(select 1 from messages where conversation_id=v.id and needs_human) as "needsHuman"
  from conversations v left join companies co on co.id=v.company_id left join campaigns a on a.id=v.campaign_id left join contacts ct on ct.id=v.contact_id
  left join lateral(select body,status,reason_uk,created_at,to_value from messages where conversation_id=v.id order by created_at desc,id desc limit 1) m on true`;
const messageSelect = `select m.id,m.conversation_id as "conversationId",m.channel,m.direction,m.source,m.subject,m.body,m.status,m.to_value as "toValue",m.reason_uk as "reasonUk",m.provider_id as "providerId",m.created_at as "createdAt",m.sent_at as "sentAt",m.classification,m.needs_human as "needsHuman",m.read_at as "readAt" from messages m join conversations v on v.id=m.conversation_id`;

export async function getInbox(
  filters: {
    campaignId?: string;
    conversationId?: string;
    channel?: string;
    status?: string;
    search?: string;
    needsHuman?: boolean;
    unread?: boolean;
  } = {},
) {
  const [conversations, campaigns] = await Promise.all([
    sonarPool.query<OutreachConversation>(
      `${conversationSelect}
      where ($1::uuid is null or v.campaign_id=$1) and ($2::text is null or v.channel=$2)
      and ($3::text is null or m.status=$3) and ($4::text is null or co.name ilike '%'||$4||'%' or coalesce(ct.value,v.peer_value,m.to_value) ilike '%'||$4||'%')
      and ($5::boolean is null or exists(select 1 from messages where conversation_id=v.id and needs_human)=$5)
      and ($6::boolean is null or exists(select 1 from messages where conversation_id=v.id and direction='in' and read_at is null)=$6)
      and ($7::uuid is null or v.id=$7)
      order by m.created_at desc nulls last,v.id`,
      [
        filters.campaignId || null,
        filters.channel || null,
        filters.status || null,
        filters.search?.trim() || null,
        filters.needsHuman ?? null,
        filters.unread ?? null,
        filters.conversationId ?? null,
      ],
    ),
    sonarPool.query<{ id: string; name: string }>(
      'select id,name from campaigns order by name,id',
    ),
  ]);
  return {
    conversations: conversations.rows,
    campaigns: campaigns.rows,
    unreadCount: conversations.rows.reduce(
      (total, c) => total + c.unreadCount,
      0,
    ),
  };
}

export async function getCompanyChat(companyId: string) {
  const [company, contacts, conversations, messages, campaigns, blocked] =
    await Promise.all([
      sonarPool.query<{ id: string; name: string }>(
        'select id,name from companies where id=$1',
        [companyId],
      ),
      sonarPool.query<OutreachContact>(
        'select id,kind,value,normalized,rank,meta from contacts where company_id=$1 order by rank desc,id',
        [companyId],
      ),
      sonarPool.query<OutreachConversation>(
        `${conversationSelect} where v.company_id=$1 order by m.created_at desc nulls last,v.id`,
        [companyId],
      ),
      sonarPool.query<OutreachMessage>(
        `${messageSelect} where v.company_id=$1 order by m.created_at,m.id`,
        [companyId],
      ),
      sonarPool.query<{
        id: string;
        name: string;
        sendMode: 'auto' | 'approval' | 'manual';
        channels: Record<string, boolean>;
      }>(
        `select a.id,a.name,a.send_mode as "sendMode",a.channels from campaigns a join campaign_companies cc on cc.campaign_id=a.id where cc.company_id=$1 order by cc.added_at desc,a.id`,
        [companyId],
      ),
      isContactBlocked(sonarPool, companyId),
    ]);
  const blockedContactIds = (
    await Promise.all(
      contacts.rows.map(async (contact) =>
        (await contactBlocked(sonarPool, companyId, contact.normalized))
          ? contact.id
          : null,
      ),
    )
  ).filter((id): id is string => id !== null);
  return {
    company: company.rows[0] ?? null,
    contacts: contacts.rows,
    conversations: conversations.rows,
    messages: messages.rows,
    campaigns: campaigns.rows,
    blocked,
    blockedContactIds,
  };
}

async function contactBlocked(
  c: Pick<PoolClient, 'query'>,
  companyId: string | null,
  to: string,
) {
  if (await isContactBlocked(c, companyId, to)) return true;
  return (
    await c.query(
      'select exists(select 1 from do_not_contact where lower(value_normalized)=lower($1)) as blocked',
      [to],
    )
  ).rows[0].blocked as boolean;
}

async function assertAllowed(
  c: PoolClient,
  companyId: string | null,
  to: string,
) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
    [companyId],
  );
  if (await contactBlocked(c, companyId, to))
    invalid('Компанія або контакт у списку «Не контактувати».');
}

async function eligibleContacts(
  c: Pick<PoolClient, 'query'>,
  companyId: string,
  channels: Record<string, boolean>,
  contactId?: string,
) {
  const { rows } = await c.query<OutreachContact>(
    `select id,kind,value,normalized,rank,meta from contacts where company_id=$1 and ($2::uuid is null or id=$2) order by rank desc,id`,
    [companyId, contactId ?? null],
  );
  const allowed: OutreachContact[] = [];
  for (const contact of rows) {
    if (
      contact.meta?.[`${contact.kind}_unavailable`] ||
      (await contactBlocked(c, companyId, contact.normalized))
    )
      continue;
    allowed.push(contact);
  }
  return selectOutreachContacts(allowed, channels);
}

async function draftVersion(c: PoolClient) {
  const {
    rows: [setting],
  } = await c.query("select value from settings where key='draft.version'");
  if (typeof setting?.value !== 'string' || !setting.value.trim())
    throw new Error('Missing draft version');
  return setting.value as string;
}
async function enqueueContact(
  c: PoolClient,
  input: DraftInput,
  userId: string | null,
) {
  const key = `ai.drafts:${input.companyId}:${input.campaignId}:${input.contactId}:${input.version}`;
  const id = await enqueueTask('ai.drafts', key, { ...input, userId }, c);
  if (id) {
    await c.query(
      "update tasks set subject_type='company',subject_id=$2 where id=$1",
      [id, input.companyId],
    );
    await logActivity(
      'ai.drafts.queued',
      'company',
      input.companyId,
      userId,
      { taskId: id, contactId: input.contactId },
      c,
    );
  }
  const {
    rows: [task],
  } = await c.query('select id,status from tasks where idempotency_key=$1', [
    key,
  ]);
  return { id: String(task.id), status: String(task.status), created: !!id };
}
export async function enqueueOutreachDrafts(
  companyId: string,
  campaignId: string,
  analysisId: string,
  existing?: PoolClient,
) {
  return transaction(async (c) => {
    const {
      rows: [campaign],
    } = await c.query(
      `select a.channels,a.status,a.min_score::float8,s.score::float8 from campaigns a join analyses an on an.campaign_id=a.id join campaign_companies cc on cc.campaign_id=a.id and cc.company_id=an.company_id left join company_scores s on s.company_id=an.company_id and s.campaign_id=a.id where a.id=$2 and an.company_id=$1 and an.id=$3`,
      [companyId, campaignId, analysisId],
    );
    if (
      !campaign ||
      campaign.status !== 'active' ||
      campaign.score === null ||
      campaign.score < campaign.min_score ||
      (await isContactBlocked(c, companyId))
    )
      return [];
    const version = await draftVersion(c);
    const contacts = await eligibleContacts(c, companyId, campaign.channels);
    const tasks = [];
    for (const contact of contacts)
      tasks.push(
        await enqueueContact(
          c,
          { companyId, campaignId, analysisId, contactId: contact.id, version },
          null,
        ),
      );
    return tasks;
  }, existing);
}
export async function enqueueDraft(
  input: {
    companyId: string;
    campaignId: string;
    contactId: string;
    requestId: string;
  },
  userId: string,
) {
  if (!input.requestId || input.requestId.length > 100)
    invalid('Вкажіть ключ запиту чернетки.');
  return transaction(async (c) => {
    const {
      rows: [campaign],
    } = await c.query(
      `select a.channels,a.min_score::float8,s.score::float8,(select id from analyses where company_id=$1 and campaign_id=a.id order by created_at desc,id desc limit 1) as analysis_id from campaigns a join campaign_companies cc on cc.campaign_id=a.id left join company_scores s on s.company_id=cc.company_id and s.campaign_id=a.id where a.id=$2 and cc.company_id=$1`,
      [input.companyId, input.campaignId],
    );
    if (!campaign?.analysis_id)
      invalid('Спочатку виконайте ІІ-аналіз компанії в цій кампанії.');
    if (campaign.score === null || campaign.score < campaign.min_score)
      invalid('Оцінка компанії нижча за поріг кампанії.');
    const [contact] = await eligibleContacts(
      c,
      input.companyId,
      campaign.channels,
      input.contactId,
    );
    if (!contact)
      return invalid('Контакт недоступний або канал кампанії вимкнено.');
    await assertAllowed(c, input.companyId, contact.normalized);
    return enqueueContact(
      c,
      {
        companyId: input.companyId,
        campaignId: input.campaignId,
        contactId: input.contactId,
        analysisId: campaign.analysis_id,
        version: await draftVersion(c),
      },
      userId,
    );
  });
}

export async function draftSnapshot(input: DraftInput, taskId: string) {
  const {
    rows: [task],
  } = await sonarPool.query(
    'select result,exists(select 1 from spend_events where task_id=tasks.id) as billed from tasks where id=$1',
    [taskId],
  );
  if (task?.result?.draftInput && (task.billed || task.result.billingPending))
    return task.result.draftInput;
  const {
    rows: [row],
  } = await sonarPool.query(
    `select co.id,co.name,co.website,co.country_code,a.offer,a.outreach_goal,a.language_code,a.channels,a.status,a.send_mode,a.min_score::float8,s.score::float8,an.result as analysis,ct.id as contact_id,ct.kind,ct.value,ct.normalized,ct.rank,ct.meta from companies co join campaign_companies cc on cc.company_id=co.id join campaigns a on a.id=cc.campaign_id join analyses an on an.company_id=co.id and an.campaign_id=a.id join contacts ct on ct.company_id=co.id left join company_scores s on s.company_id=co.id and s.campaign_id=a.id where co.id=$1 and a.id=$2 and an.id=$3 and ct.id=$4`,
    [input.companyId, input.campaignId, input.analysisId, input.contactId],
  );
  if (
    !row ||
    row.score === null ||
    row.score < row.min_score ||
    (await contactBlocked(sonarPool, input.companyId, row.normalized))
  )
    return null;
  const contact = {
    id: String(row.contact_id),
    kind: String(row.kind),
    value: String(row.value),
    normalized: String(row.normalized),
    rank: Number(row.rank),
    meta: row.meta,
  };
  const [eligible] = selectOutreachContacts([contact], row.channels);
  if (!eligible || contact.meta?.[`${contact.kind}_unavailable`]) return null;
  const { rows: existing } = await sonarPool.query(
    'select id from messages where idempotency_key=$1',
    [`outreach:${taskId}`],
  );
  const { rows: settings } = await sonarPool.query(
    "select key,value from settings where key like 'draft.%' or key in ('company.about','ai.models','ai.model.cheap')",
  );
  const config = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  const snapshot = {
    existingMessageId: existing[0]?.id,
    channel: eligible.channel,
    contact,
    analysis: row.analysis,
    company: {
      id: row.id,
      name: row.name,
      website: row.website,
      countryCode: row.country_code,
    },
    offer: row.offer,
    outreachGoal: row.outreach_goal,
    languageCode: row.language_code,
    about:
      typeof config['company.about'] === 'string'
        ? config['company.about']
        : '',
    config,
  };
  await sonarPool.query(
    "update tasks set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('draftInput',$2::jsonb) where id=$1",
    [taskId, JSON.stringify(snapshot)],
  );
  return snapshot;
}

async function queue(c: PoolClient, id: string, companyId: string | null) {
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
export async function saveOutreachDraft(
  input: DraftInput,
  draft: { subject: string; body: string },
  taskId: string,
) {
  return transaction(async (c) => {
    const {
      rows: [prior],
    } = await c.query(
      'select id,status from messages where idempotency_key=$1',
      [`outreach:${taskId}`],
    );
    if (prior) return { id: String(prior.id), status: String(prior.status) };
    const {
      rows: [row],
    } = await c.query(
      `select a.send_mode,a.channels,a.status,a.min_score::float8,s.score::float8,ct.normalized,ct.kind,ct.meta from campaigns a join campaign_companies cc on cc.campaign_id=a.id join contacts ct on ct.company_id=cc.company_id left join company_scores s on s.company_id=cc.company_id and s.campaign_id=a.id where a.id=$2 and cc.company_id=$1 and ct.id=$3 for share of a,ct`,
      [input.companyId, input.campaignId, input.contactId],
    );
    if (!row) invalid('Контакт або кампанію не знайдено.');
    await assertAllowed(c, input.companyId, row.normalized);
    const [contact] = selectOutreachContacts(
      [
        {
          id: input.contactId,
          kind: row.kind,
          normalized: row.normalized,
          rank: 0,
        },
      ],
      row.channels,
    );
    if (!contact || row.meta?.[`${row.kind}_unavailable`])
      return invalid('Контакт недоступний або канал кампанії вимкнено.');
    const channel = contact.channel;
    validateDraft(draft, channel);
    const {
      rows: [account],
    } = await c.query(
      "select id from channel_accounts where channel=$1 and status='active' order by created_at,id limit 1",
      [channel],
    );
    const canAuto =
      automatic.includes(channel) &&
      row.send_mode === 'auto' &&
      row.status === 'active' &&
      row.score !== null &&
      row.score >= row.min_score &&
      !!account;
    const status = canAuto ? 'queued' : 'draft';
    const {
      rows: [conversation],
    } = await c.query(
      `insert into conversations(company_id,campaign_id,contact_id,channel) values($1,$2,$3,$4) on conflict(company_id,campaign_id,contact_id,channel) where provider_thread_id is null do update set channel=excluded.channel returning id`,
      [input.companyId, input.campaignId, input.contactId, channel],
    );
    const {
      rows: [message],
    } = await c.query(
      `insert into messages(conversation_id,account_id,to_value,subject,body,status,idempotency_key,channel,source,scheduled_at) values($1,$2,$3,$4,$5,$6,$7,$8,'generated',case when $6='queued' then now() else null end) on conflict(idempotency_key) do update set idempotency_key=messages.idempotency_key returning id,status`,
      [
        conversation.id,
        account?.id ?? null,
        row.normalized,
        draft.subject.trim(),
        draft.body.trim(),
        status,
        `outreach:${taskId}`,
        channel,
      ],
    );
    if (message.status === 'queued')
      await queue(c, message.id, input.companyId);
    else if (
      row.send_mode === 'auto' &&
      automatic.includes(channel) &&
      !account
    ) {
      await c.query('update messages set reason_uk=$2 where id=$1', [
        message.id,
        'Налаштуйте активний акаунт каналу для автоматичного надсилання.',
      ]);
    }
    await logActivity(
      'outreach.draft.created',
      'company',
      input.companyId,
      null,
      { messageId: message.id, taskId, contactId: input.contactId },
      c,
    );
    return { id: String(message.id), status: String(message.status) };
  });
}

function validateDraft(
  draft: { subject?: string; body: string },
  channel: string,
) {
  if (
    !draft.body?.trim() ||
    draft.body.length > 100000 ||
    (draft.subject?.length ?? 0) > 998 ||
    /[\r\n]/.test(draft.subject ?? '') ||
    (channel === 'email' && !draft.subject?.trim())
  )
    invalid('Вкажіть текст повідомлення та коректну тему для email.');
}
async function lockedMessage(c: PoolClient, id: string) {
  const {
    rows: [identity],
  } = await c.query(
    'select v.company_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1',
    [id],
  );
  if (!identity) invalid('Повідомлення не знайдено.');
  await assertAllowed(c, identity.company_id, '');
  const {
    rows: [message],
  } = await c.query(
    `select m.*,v.company_id,v.campaign_id,v.contact_id,coalesce(a.channels,jsonb_build_object(m.channel,true)) as channels,coalesce(a.status,'active') as campaign_status,case when m.source='reply' then 'manual' else a.send_mode end as send_mode,ct.kind as contact_kind,ct.meta as contact_meta from messages m join conversations v on v.id=m.conversation_id left join campaigns a on a.id=v.campaign_id left join contacts ct on ct.id=v.contact_id where m.id=$1 for update of m`,
    [id],
  );
  await assertAllowed(c, message.company_id, message.to_value);
  return message;
}
export async function editOutreachDraft(
  messageId: string,
  draft: { subject?: string; body: string },
  userId: string,
) {
  return transaction(async (c) => {
    const message = await lockedMessage(c, messageId);
    if (!editable.includes(message.status) || message.first_attempt_at)
      invalid('Це повідомлення вже не можна редагувати.');
    const subject = draft.subject ?? message.subject;
    validateDraft({ ...draft, subject }, message.channel);
    await c.query(
      'update messages set subject=$2,body=$3,created_by=coalesce(created_by,$4) where id=$1',
      [messageId, subject.trim(), draft.body.trim(), userId],
    );
    await logActivity(
      'outreach.draft.edited',
      'company',
      message.company_id,
      userId,
      { messageId },
      c,
    );
    return { id: messageId, status: String(message.status) };
  });
}
export async function sendOutreachDraft(messageId: string, userId: string) {
  return submitOutreachDraft(messageId, userId, false);
}
export async function approveOutreachDraft(messageId: string, userId: string) {
  return submitOutreachDraft(messageId, userId, true);
}
async function submitOutreachDraft(
  messageId: string,
  userId: string,
  approve: boolean,
) {
  return transaction(async (c) => {
    const message = await lockedMessage(c, messageId);
    if (
      message.status === 'queued' ||
      ['sent', 'delivered', 'read'].includes(message.status)
    )
      return { id: messageId, status: String(message.status) };
    if (approve && message.status !== 'awaiting_approval')
      invalid('Спочатку передайте чернетку на одобрення.');
    if (
      !editable.includes(message.status) ||
      message.first_attempt_at ||
      !automatic.includes(message.channel)
    )
      invalid(
        'Цей канал або стан повідомлення не підтримує автоматичне надсилання.',
      );
    if (
      message.channels?.[message.channel] !== true ||
      message.campaign_status !== 'active' ||
      (!message.contact_id && message.source !== 'reply') ||
      message.contact_meta?.[`${message.channel}_unavailable`]
    )
      invalid(
        'Активуйте кампанію та доступний канал контакту перед надсиланням.',
      );
    if (!approve && message.send_mode === 'approval') {
      await c.query(
        "update messages set status='awaiting_approval',created_by=coalesce(created_by,$2),approved_by=null,approved_at=null where id=$1",
        [messageId, userId],
      );
      await logActivity(
        'outreach.message.submitted',
        'company',
        message.company_id,
        userId,
        { messageId },
        c,
      );
      return { id: messageId, status: 'awaiting_approval' };
    }
    const {
      rows: [account],
    } = await c.query(
      "select id from channel_accounts where channel=$1 and status='active' and ($3::boolean=false or id=$2) order by (id=$2) desc,created_at,id limit 1 for share",
      [message.channel, message.account_id, message.source === 'reply'],
    );
    if (!account) invalid('Налаштуйте активний акаунт каналу.');
    await c.query(
      "update messages set account_id=$2,status='queued',created_by=coalesce(created_by,$3),approved_by=$3,approved_at=now(),scheduled_at=now(),reason_uk=null where id=$1",
      [messageId, account.id, userId],
    );
    await queue(c, messageId, message.company_id);
    await logActivity(
      'outreach.message.queued',
      'company',
      message.company_id,
      userId,
      { messageId },
      c,
    );
    return { id: messageId, status: 'queued' };
  });
}
export async function markOutreachManualSent(
  messageId: string,
  userId: string,
) {
  return transaction(async (c) => {
    const message = await lockedMessage(c, messageId);
    if (!['form', 'social'].includes(message.channel))
      invalid('Ручне підтвердження доступне для форм та соцмереж.');
    if (message.status === 'sent') return { id: messageId, status: 'sent' };
    if (!editable.includes(message.status) || message.first_attempt_at)
      invalid('Це повідомлення вже не можна позначити надісланим.');
    await c.query(
      "update messages set status='sent',source='manual',sent_at=now(),created_by=coalesce(created_by,$2),reason_uk=null where id=$1",
      [messageId, userId],
    );
    await logActivity(
      'outreach.message.manual',
      'company',
      message.company_id,
      userId,
      { messageId },
      c,
    );
    return { id: messageId, status: 'sent' };
  });
}
export async function skipOutreachMessage(messageId: string, userId: string) {
  return transaction(async (c) => {
    const message = await lockedMessage(c, messageId);
    if (message.status === 'skipped')
      return { id: messageId, status: 'skipped' };
    if (!editable.includes(message.status) || message.first_attempt_at)
      invalid('Це повідомлення вже не можна пропустити.');
    await c.query(
      "update messages set status='skipped',reason_uk='Пропущено користувачем.' where id=$1",
      [messageId],
    );
    await logActivity(
      'outreach.message.skipped',
      'company',
      message.company_id,
      userId,
      { messageId },
      c,
    );
    return { id: messageId, status: 'skipped' };
  });
}
export async function logOutreachCall(
  input: {
    companyId: string;
    campaignId: string;
    contactId: string;
    body: string;
    requestId: string;
  },
  userId: string,
) {
  validateDraft(input, 'call');
  if (!input.requestId || input.requestId.length > 100)
    invalid('Вкажіть ключ нотатки дзвінка.');
  return transaction(async (c) => {
    const {
      rows: [contact],
    } = await c.query(
      `select ct.normalized from contacts ct join campaign_companies cc on cc.company_id=ct.company_id where ct.id=$1 and ct.company_id=$2 and ct.kind='phone' and cc.campaign_id=$3`,
      [input.contactId, input.companyId, input.campaignId],
    );
    if (!contact) invalid('Оберіть телефон компанії та її кампанію.');
    await assertAllowed(c, input.companyId, contact.normalized);
    const {
      rows: [conversation],
    } = await c.query(
      `insert into conversations(company_id,campaign_id,contact_id,channel) values($1,$2,$3,'call') on conflict(company_id,campaign_id,contact_id,channel) where provider_thread_id is null do update set channel=excluded.channel returning id`,
      [input.companyId, input.campaignId, input.contactId],
    );
    const {
      rows: [message],
    } = await c.query(
      `insert into messages(conversation_id,to_value,subject,body,status,idempotency_key,channel,source,sent_at,created_by) values($1,$2,'',$3,'sent',$4,'call','manual',now(),$5) on conflict(idempotency_key) do update set idempotency_key=messages.idempotency_key returning id,status,conversation_id,body`,
      [
        conversation.id,
        contact.normalized,
        input.body.trim(),
        `outreach.call:${input.requestId}`,
        userId,
      ],
    );
    if (
      message.conversation_id !== conversation.id ||
      message.body !== input.body.trim()
    )
      invalid('Ключ нотатки вже використано для іншого запиту.');
    await logActivity(
      'outreach.call.logged',
      'company',
      input.companyId,
      userId,
      { messageId: message.id },
      c,
    );
    return { id: String(message.id), status: String(message.status) };
  });
}
