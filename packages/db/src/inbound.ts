import { createHash } from 'node:crypto';
import { normalizeTelegramRecipient } from '@sonar/core/telegram';
import { normalizeWhatsAppRecipient } from '@sonar/core/whatsapp';
import { sonarPool } from './index.js';
import {
  EmailValidationError,
  isContactBlocked,
  transaction,
} from './email.js';
import { enqueueTask, logActivity } from './tasks.js';
import { getInbox, type OutreachMessage } from './outreach.js';

export type InboundCategory =
  | 'interest'
  | 'question'
  | 'price'
  | 'contract'
  | 'complaint'
  | 'refusal'
  | 'autoreply';
export interface InboundInput {
  channel: 'email' | 'telegram' | 'whatsapp';
  accountId: string;
  providerId: string;
  externalMessageId?: string;
  sender: string;
  senderPhone?: string;
  subject?: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  receivedAt?: Date | string;
}
const invalid = (reason: string): never => {
  throw new EmailValidationError(reason);
};
const normalize = (channel: string, value: string) => {
  const address =
    channel === 'email'
      ? (value.match(/<([^<>]+)>/)?.[1] ?? value).trim()
      : value;
  return channel === 'email'
    ? /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)
      ? address.toLowerCase()
      : null
    : channel === 'telegram'
      ? /^telegram:user:[1-9]\d*(?::-?\d+)?$/.test(address)
        ? address
        : normalizeTelegramRecipient(address)?.toLowerCase()
      : normalizeWhatsAppRecipient(address);
};

export async function recordInbound(input: InboundInput) {
  const sender = normalize(input.channel, input.sender);
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (
    !sender ||
    !input.providerId?.trim() ||
    input.providerId.length > 1000 ||
    (input.externalMessageId?.length ?? 0) > 1000 ||
    /[\r\n]/.test(input.externalMessageId ?? '') ||
    typeof input.body !== 'string' ||
    input.body.length > 100000 ||
    !Number.isFinite(receivedAt.getTime())
  )
    invalid('Некоректне вхідне повідомлення.');
  const providerId = input.providerId.trim();
  const key = `inbound:${input.channel}:${input.accountId}:${createHash('sha256').update(providerId).digest('hex')}`;
  return transaction(async (c) => {
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      key,
    ]);
    const {
      rows: [prior],
    } = await c.query(
      'select m.id as "messageId",m.conversation_id as "conversationId",v.company_id as "companyId" from messages m join conversations v on v.id=m.conversation_id where m.idempotency_key=$1',
      [key],
    );
    if (prior) return { ...prior, created: false };
    const {
      rows: [account],
    } = await c.query(
      'select id from channel_accounts where id=$1 and channel=$2',
      [input.accountId, input.channel],
    );
    if (!account) invalid('Акаунт вхідного каналу не знайдено.');
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `inbound-peer:${input.accountId}:${input.channel}:${sender}`,
    ]);
    const refs = [input.inReplyTo, ...(input.references ?? [])]
      .filter((r): r is string => !!r)
      .map((r) => r.replace(/^<|>$/g, ''));
    const {
      rows: [thread],
    } = await c.query(
      `select v.* from conversations v join messages m on m.conversation_id=v.id where v.channel=$1 and m.account_id=$2 and ($1='email' and (trim(both '<>' from m.provider_id)=any($3::text[]) or trim(both '<>' from m.rfc_message_id)=any($3::text[])) or lower(m.to_value)=any($4::text[])) order by (coalesce(trim(both '<>' from m.provider_id)=any($3::text[]),false) or coalesce(trim(both '<>' from m.rfc_message_id)=any($3::text[]),false)) desc,m.created_at desc,m.id desc limit 1`,
      [
        input.channel,
        input.accountId,
        refs,
        [
          sender,
          input.senderPhone && normalize(input.channel, input.senderPhone),
        ].filter(Boolean),
      ],
    );
    const {
      rows: [peer],
    } = await c.query(
      'select * from conversations where channel=$1 and account_id=$2 and peer_value=$3',
      [input.channel, input.accountId, sender],
    );
    let conversation = thread ?? peer;
    if (!conversation) {
      const aliases = [
        sender,
        input.senderPhone && normalize(input.channel, input.senderPhone),
      ].filter(Boolean);
      const { rows: candidates } = await c.query(
        `select id,company_id from contacts where kind=any($1::text[]) and lower(normalized)=any($2::text[]) order by rank desc,id`,
        [
          input.channel === 'email' ? ['email'] : [input.channel, 'phone'],
          aliases,
        ],
      );
      const companyId =
        new Set(candidates.map((r) => r.company_id)).size === 1
          ? candidates[0]?.company_id
          : null;
      const contactId = companyId ? candidates[0].id : null;
      const {
        rows: [campaign],
      } = companyId
        ? await c.query(
            'select campaign_id from campaign_companies where company_id=$1 order by added_at desc,campaign_id limit 1',
            [companyId],
          )
        : { rows: [] };
      const {
        rows: [created],
      } = await c.query(
        `insert into conversations(company_id,campaign_id,contact_id,channel,account_id,peer_value) values($1,$2,$3,$4,$5,$6) on conflict(company_id,campaign_id,contact_id,channel) do update set channel=excluded.channel returning *`,
        [
          companyId,
          campaign?.campaign_id ?? null,
          contactId,
          input.channel,
          input.accountId,
          sender,
        ],
      );
      conversation = created;
    }
    const {
      rows: [message],
    } = await c.query(
      `insert into messages(conversation_id,account_id,direction,source,channel,to_value,subject,body,status,idempotency_key,provider_id,created_at,rfc_message_id) values($1,$2,'in','inbound',$3,$4,$5,$6,'delivered',$7,$8,$9,$10) returning id`,
      [
        conversation.id,
        input.accountId,
        input.channel,
        sender,
        input.subject ?? '',
        input.body,
        key,
        providerId,
        receivedAt,
        input.externalMessageId ?? null,
      ],
    );
    await enqueueTask(
      'ai.inbound',
      `ai.inbound:${message.id}`,
      { messageId: message.id },
      c,
    );
    await logActivity(
      'message.received',
      conversation.company_id ? 'company' : 'conversation',
      conversation.company_id ?? conversation.id,
      null,
      { messageId: message.id, channel: input.channel },
      c,
    );
    return {
      messageId: String(message.id),
      conversationId: String(conversation.id),
      companyId: conversation.company_id as string | null,
      created: true,
    };
  });
}

export async function getInboundMessage(messageId: string) {
  return (
    (
      await sonarPool.query(
        `select m.id,m.body,m.subject,m.channel,m.conversation_id as "conversationId",v.company_id as "companyId",v.campaign_id as "campaignId" from messages m join conversations v on v.id=m.conversation_id where m.id=$1 and m.direction='in'`,
        [messageId],
      )
    ).rows[0] ?? null
  );
}
export async function applyInboundClassification(
  messageId: string,
  category: InboundCategory,
) {
  if (
    ![
      'interest',
      'question',
      'price',
      'contract',
      'complaint',
      'refusal',
      'autoreply',
    ].includes(category)
  )
    invalid('Невідома категорія вхідного повідомлення.');
  return transaction(async (c) => {
    const {
      rows: [identity],
    } = await c.query(
      "select v.company_id,m.channel,m.to_value from messages m join conversations v on v.id=m.conversation_id where m.id=$1 and m.direction='in'",
      [messageId],
    );
    if (!identity) return false;
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
      [
        identity.company_id ??
          `recipient:${identity.channel}:${identity.to_value.toLowerCase()}`,
      ],
    );
    const {
      rows: [m],
    } = await c.query(
      'select m.*,v.company_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1 for update of m',
      [messageId],
    );
    if (m.classification) return true;
    await c.query(
      'update messages set classification=$2,needs_human=$3 where id=$1',
      [
        messageId,
        category,
        ['question', 'price', 'contract', 'complaint'].includes(category),
      ],
    );
    if (category === 'refusal') {
      await c.query(
        `insert into do_not_contact(company_id,kind,value_normalized,reason) values($1,$2,$3,'Відмова у вхідному повідомленні.') on conflict(kind,value_normalized) do nothing`,
        [m.company_id, m.channel, m.to_value],
      );
      if (m.company_id) {
        await c.query(
          `insert into do_not_contact(company_id,kind,value_normalized,reason) values($1,'company',$1::text,'Відмова у вхідному повідомленні.') on conflict(kind,value_normalized) do nothing`,
          [m.company_id],
        );
        await c.query(
          "update companies set status='refused',updated_at=now() where id=$1",
          [m.company_id],
        );
      }
    } else if (category !== 'autoreply' && m.company_id) {
      await c.query(
        `update companies set status=case when $2='interest' then 'interested' when status='interested' then status else 'replied' end,updated_at=now() where id=$1 and status not in ('deal','refused','do_not_contact')`,
        [m.company_id, category],
      );
    }
    await logActivity(
      'message.classified',
      m.company_id ? 'company' : 'conversation',
      m.company_id ?? m.conversation_id,
      null,
      { messageId, category },
      c,
    );
    return true;
  });
}

export async function getConversationChat(
  conversationId: string,
  historyLimit?: number,
) {
  const { conversations } = await getInbox({ conversationId });
  const conversation =
    conversations.find((c) => c.id === conversationId) ?? null;
  const { rows: messages } = await sonarPool.query<OutreachMessage>(
    `select id,conversation_id as "conversationId",channel,direction,source,subject,body,status,to_value as "toValue",reason_uk as "reasonUk",created_at as "createdAt",sent_at as "sentAt",classification,needs_human as "needsHuman",read_at as "readAt" from messages where conversation_id=$1 and ($2::int is null or direction='in' or status in ('sent','delivered','read')) order by created_at desc,id desc limit $2`,
    [conversationId, historyLimit ?? null],
  );
  messages.reverse();
  const recipient =
    [...messages].reverse().find((m) => m.direction === 'in')?.toValue ??
    messages[0]?.toValue ??
    '';
  return {
    conversation,
    messages,
    blocked: conversation
      ? await isContactBlocked(sonarPool, conversation.companyId, recipient)
      : false,
  };
}
export async function getConversationHistory(conversationId: string) {
  const {
    rows: [setting],
  } = await sonarPool.query(
    "select value from settings where key='inbound.history_limit'",
  );
  const historyLimit = Number(setting?.value);
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 500)
    throw new Error('Invalid inbound.history_limit');
  const chat = await getConversationChat(conversationId, historyLimit);
  const {
    rows: [company],
  } = await sonarPool.query(
    'select id,name,website,country_code as "countryCode" from companies where id=$1',
    [chat.conversation?.companyId ?? null],
  );
  const {
    rows: [campaign],
  } = await sonarPool.query(
    'select id,name,offer,outreach_goal as "outreachGoal",language_code as "languageCode" from campaigns where id=$1',
    [chat.conversation?.campaignId ?? null],
  );
  return {
    ...chat,
    company: company ?? null,
    campaign: campaign ?? null,
    historyLimit,
  };
}
export async function markConversationRead(
  conversationId: string,
  throughMessageId?: string,
) {
  if (!throughMessageId) return;
  await sonarPool.query(
    "update messages set read_at=now() where conversation_id=$1 and direction='in' and read_at is null and (created_at,id)<=(select created_at,id from messages where id=$2 and conversation_id=$1 and direction='in')",
    [conversationId, throughMessageId],
  );
}
export async function enqueueReply(
  conversationId: string,
  requestId: string,
  userId: string,
) {
  if (!requestId || requestId.length > 100)
    invalid('Вкажіть ключ запиту відповіді.');
  const chat = await getConversationChat(conversationId);
  if (!chat.conversation || chat.blocked)
    invalid('Діалог недоступний або контакт у стоп-списку.');
  const id = await enqueueTask(
    'ai.reply',
    `ai.reply:${conversationId}:${requestId}`,
    { conversationId, userId },
  );
  const {
    rows: [task],
  } = await sonarPool.query(
    'select id,status from tasks where idempotency_key=$1',
    [`ai.reply:${conversationId}:${requestId}`],
  );
  return { ...task, created: !!id };
}
async function reply(
  conversationId: string,
  draft: { subject?: string; body: string },
  key: string,
  userId: string | null,
  queued: boolean,
) {
  if (
    !draft.body?.trim() ||
    draft.body.length > 100000 ||
    (draft.subject?.length ?? 0) > 998 ||
    /[\r\n]/.test(draft.subject ?? '')
  )
    invalid('Вкажіть коректний текст відповіді.');
  return transaction(async (c) => {
    const {
      rows: [v],
    } = await c.query('select * from conversations where id=$1 for update', [
      conversationId,
    ]);
    if (!v || !['email', 'telegram', 'whatsapp'].includes(v.channel))
      invalid('Цей діалог не підтримує відповіді.');
    if (v.company_id)
      await c.query(
        "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
        [v.company_id],
      );
    const {
      rows: [last],
    } = await c.query(
      "select account_id,to_value,subject from messages where conversation_id=$1 order by (direction='in') desc,created_at desc,id desc limit 1",
      [conversationId],
    );
    if (!last || (await isContactBlocked(c, v.company_id, last.to_value)))
      invalid('Контакт у списку «Не контактувати».');
    const {
      rows: [prior],
    } = await c.query(
      'select id,status,conversation_id,body from messages where idempotency_key=$1',
      [key],
    );
    if (prior) {
      if (
        prior.conversation_id !== conversationId ||
        prior.body !== draft.body.trim()
      )
        invalid('Ключ повідомлення вже використано для іншого запиту.');
      return { id: String(prior.id), status: String(prior.status) };
    }
    const subject =
      draft.subject?.trim() ||
      last.subject ||
      (v.channel === 'email' ? 'Re:' : '');
    const {
      rows: [m],
    } = await c.query(
      `insert into messages(conversation_id,account_id,channel,source,to_value,subject,body,status,idempotency_key,created_by,approved_by,approved_at,scheduled_at) values($1,$2,$3,'reply',$4,$5,$6,$7,$8,$9,$9,case when $10 then now() end,case when $10 then now() end) returning id,status`,
      [
        conversationId,
        last.account_id,
        v.channel,
        last.to_value,
        subject,
        draft.body.trim(),
        queued ? 'queued' : 'draft',
        key,
        userId,
        queued,
      ],
    );
    if (queued)
      await enqueueTask(
        'message.send',
        `message.send:${m.id}`,
        { messageId: m.id },
        c,
      );
    await logActivity(
      queued ? 'message.reply.queued' : 'message.reply.drafted',
      v.company_id ? 'company' : 'conversation',
      v.company_id ?? conversationId,
      userId,
      { messageId: m.id },
      c,
    );
    return { id: String(m.id), status: String(m.status) };
  });
}
export async function saveReplyDraft(
  conversationId: string,
  draft: { subject?: string; body: string },
  taskId: string,
) {
  return reply(conversationId, draft, `reply.draft:${taskId}`, null, false);
}
export async function queueConversationReply(
  input: {
    conversationId: string;
    subject?: string;
    body: string;
    requestId: string;
  },
  userId: string,
) {
  if (!input.requestId || input.requestId.length > 100)
    invalid('Вкажіть ключ повідомлення.');
  return reply(
    input.conversationId,
    input,
    `reply:${input.conversationId}:${input.requestId}`,
    userId,
    true,
  );
}
