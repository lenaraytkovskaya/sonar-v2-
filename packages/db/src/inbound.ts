import { enqueueFormReplyMatch } from './form-replies.js';
import { messageHistoryOrder } from './message-history.js';
import { createHash } from 'node:crypto';
import { socialTarget } from '@sonar/core';
import { normalizeTelegramRecipient } from '@sonar/core/telegram';
import { normalizeWhatsAppRecipient } from '@sonar/core/whatsapp';
import { sonarPool } from './index.js';
import {
  canonicalConversation,
  lockConversation,
  conversationAliases,
  lockWhatsAppIdentity,
  whatsappConversation,
} from './whatsapp-identity.js';
import {
  EmailValidationError,
  isContactBlocked,
  transaction,
} from './email.js';
import { assertFacebookBinding } from './social-inbox.js';
import { canonicalSocialPeer } from '@sonar/core/social-inbox';
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
    let conversation;
    if (input.channel === 'whatsapp') {
      conversation = (
        await whatsappConversation(
          c,
          input.accountId,
          sender!,
          input.senderPhone,
        )
      ).conversation;
    } else {
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
      conversation = thread ?? peer;
      if (!conversation) {
        const aliases = [
          sender,
          input.senderPhone && normalize(input.channel, input.senderPhone),
        ].filter(Boolean);
        const { rows: candidates } = await c.query(
          `select id,company_id from contacts where kind::text=any($1::text[]) and lower(normalized)=any($2::text[]) order by rank desc,id`,
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
          `insert into conversations(company_id,campaign_id,contact_id,channel,account_id,peer_value) values($1,$2,$3,$4,$5,$6) on conflict(company_id,campaign_id,contact_id,channel) where provider_thread_id is null and channel <> 'whatsapp' do update set channel=excluded.channel returning *`,
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
    if (!conversation.company_id)
      await enqueueFormReplyMatch(
        c,
        conversation.id,
        message.id,
        input.senderPhone,
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
      rows: [account],
    } = await c.query(
      "select account_id from messages where id=$1 and channel='whatsapp'",
      [messageId],
    );
    if (account?.account_id) await lockWhatsAppIdentity(c, account.account_id);
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
          `insert into do_not_contact(company_id,kind,value_normalized,reason) values($1::uuid,'company',$1::text,'Відмова у вхідному повідомленні.') on conflict(kind,value_normalized) do nothing`,
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
    if (category === 'refusal' && m.channel === 'whatsapp')
      await whatsappConversation(c, m.account_id, m.to_value);
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
  conversationId = await canonicalConversation(sonarPool, conversationId);
  const { conversations } = await getInbox({ conversationId });
  const conversation =
    conversations.find((c) => c.id === conversationId) ?? null;
  const { rows: messages } = await sonarPool.query<OutreachMessage>(
    `select id,conversation_id as "conversationId",channel,direction,source,subject,body,status,to_value as "toValue",reason_uk as "reasonUk",provider_id as "providerId",created_at as "createdAt",sent_at as "sentAt",classification,needs_human as "needsHuman",read_at as "readAt",(social_meta->'occurredAt'='null'::jsonb) as "providerTimestampUnknown" from messages where conversation_id=$1 and ($2::int is null or direction='in' or status in ('sent','delivered','read')) order by ${messageHistoryOrder('desc')} limit $2`,
    [conversationId, historyLimit ?? null],
  );
  messages.reverse();
  const recipient =
    [...messages].reverse().find((m) => m.direction === 'in')?.toValue ??
    messages[0]?.toValue ??
    conversation?.contactValue ??
    '';
  const target =
    conversation?.channel === 'social'
      ? socialTarget(conversation.contactValue)
      : null;
  const network =
    target &&
    target.kind !== 'unsupported' &&
    (target.network !== 'linkedin' || target.kind === 'company')
      ? target.network
      : null;
  const socialAvailable = network
    ? ((
        await sonarPool.query(
          "select exists(select 1 from channel_accounts a join conversations v on v.id=$2 where a.channel=$1 and a.status='active' and a.settings->>'sessionStatus'='valid' and (v.provider_thread_id is null or v.account_id=a.id)) as available",
          [network, conversationId],
        )
      ).rows[0].available as boolean)
    : false;
  return {
    conversation,
    messages,
    socialAvailable,
    blocked: conversation
      ? await isContactBlocked(sonarPool, conversation.companyId, recipient)
      : false,
  };
}
export async function getConversationHistory(conversationId: string) {
  conversationId = await canonicalConversation(sonarPool, conversationId);
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
/** UI calls supply the ordered IDs from the displayed snapshot. The explicit
 * prefix excludes messages inserted after that view, even before its last ID.
 * Server-only callers may assert the current ordered prefix with throughId alone. */
export async function markConversationRead(
  conversationId: string,
  throughMessageId?: string,
  visibleMessageIds?: readonly string[],
) {
  if (!throughMessageId) return;
  await transaction(async (c) => {
    const conversation = await lockConversation(c, conversationId);
    if (visibleMessageIds) {
      const boundary = visibleMessageIds.indexOf(throughMessageId);
      if (boundary < 0) return;
      await c.query(
        "update messages set read_at=now() where conversation_id=$1 and direction='in' and read_at is null and id=any($2::uuid[])",
        [conversation.id, visibleMessageIds.slice(0, boundary + 1)],
      );
      return;
    }
    await c.query(
      `with ordered as (
    select id,row_number() over(order by ${messageHistoryOrder('asc')}) as position from messages where conversation_id=$1 and direction='in'
  ) update messages m set read_at=now() from ordered o where m.id=o.id and m.read_at is null
    and o.position<=(select position from ordered where id=$2)`,
      [conversation.id, throughMessageId],
    );
  });
}
export async function enqueueReply(
  conversationId: string,
  requestId: string,
  userId: string,
) {
  if (!requestId || requestId.length > 100)
    invalid('Вкажіть ключ запиту відповіді.');
  return transaction(async (c) => {
    const conversation = await lockConversation(c, conversationId);
    const {
      rows: [peer],
    } = await c.query(
      `select coalesce(
      (select to_value from messages where conversation_id=v.id and direction='in' order by ${messageHistoryOrder('desc')} limit 1),
      (select to_value from messages where conversation_id=v.id order by ${messageHistoryOrder('asc')} limit 1),
      ct.value,v.peer_value,'') as recipient from conversations v left join contacts ct on ct.id=v.contact_id where v.id=$1`,
      [conversation.id],
    );
    if (conversation.company_id)
      await c.query(
        "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
        [conversation.company_id],
      );
    if (await isContactBlocked(c, conversation.company_id, peer.recipient))
      invalid('Діалог недоступний або контакт у стоп-списку.');
    const aliases = await conversationAliases(c, conversation);
    const keys = aliases.map((id) => `ai.reply:${id}:${requestId}`);
    const { rows: prior } = await c.query(
      'select id,status,type,payload from tasks where idempotency_key=any($1::text[]) order by created_at,id',
      [keys],
    );
    if (prior.length) {
      if (
        prior.some(
          (task) =>
            task.type !== 'ai.reply' ||
            !aliases.includes(task.payload.conversationId),
        )
      )
        invalid('Ключ запиту відповіді вже використано для іншого діалогу.');
      return { id: prior[0].id, status: prior[0].status, created: false };
    }
    const key = `ai.reply:${conversation.id}:${requestId}`;
    const created = await enqueueTask(
      'ai.reply',
      key,
      { conversationId: conversation.id, userId },
      c,
    );
    const {
      rows: [task],
    } = await c.query(
      'select id,status,type,payload from tasks where idempotency_key=$1',
      [key],
    );
    if (
      !task ||
      task.type !== 'ai.reply' ||
      !aliases.includes(task.payload.conversationId)
    )
      invalid('Ключ запиту відповіді вже використано для іншого діалогу.');
    return { id: task.id, status: task.status, created: !!created };
  });
}
export async function getConversationReplyTask(
  conversationId: string,
  taskId: string,
) {
  // One read snapshot scopes legacy task payloads without blocking status polling on a send.
  const { rows } = await sonarPool.query(
    `with recursive chain as (
    select id,merged_into_id from conversations where id=$2
    union all select v.id,v.merged_into_id from conversations v join chain p on v.id=p.merged_into_id
  ), aliases as (
    select id from chain where merged_into_id is null
    union all select v.id from conversations v join aliases a on v.merged_into_id=a.id
  ) select id,status,reason_uk from tasks where id=$1 and type='ai.reply'
    and payload->>'conversationId' in(select id::text from aliases)`,
    [taskId, conversationId],
  );
  return rows[0] ?? null;
}

const manualChannels = ['form', 'social', 'call'];
/**
 * Finds or opens the dialog for a contact so a person can write by hand from the inbox.
 * A phone opens WhatsApp (or Telegram) when such an account is active, otherwise a call log.
 */
export async function ensureContactConversation(
  contactId: string,
  campaignId?: string,
) {
  return transaction(async (c) => {
    const {
      rows: [contact],
    } = await c.query(
      'select id,company_id,kind::text as kind from contacts where id=$1',
      [contactId],
    );
    if (!contact) invalid('Контакт не знайдено.');
    const {
      rows: [campaign],
    } = await c.query(
      'select campaign_id from campaign_companies where company_id=$1 and ($2::uuid is null or campaign_id=$2::uuid) order by added_at desc limit 1',
      [contact.company_id, campaignId ?? null],
    );
    if (!campaign) invalid('Додайте компанію до кампанії.');
    let channel: string | null = [
      'email',
      'telegram',
      'whatsapp',
      ...manualChannels,
    ].includes(contact.kind)
      ? contact.kind
      : null;
    if (contact.kind === 'phone') {
      const {
        rows: [active],
      } = await c.query(
        "select channel from channel_accounts where channel in ('whatsapp','telegram') and status='active' order by channel='whatsapp' desc limit 1",
      );
      channel = active?.channel ?? 'call';
    }
    if (!channel) invalid('Цей контакт не підтримує переписку.');
    if (channel === 'whatsapp') {
      const {
        rows: [account],
      } = await c.query(
        "select id from channel_accounts where channel='whatsapp' and status='active' order by created_at,id limit 1",
      );
      if (!account) invalid('Підключіть активний акаунт WhatsApp.');
      const {
        rows: [address],
      } = await c.query('select normalized from contacts where id=$1', [
        contactId,
      ]);
      return (
        await whatsappConversation(
          c,
          account.id,
          address.normalized,
          undefined,
          {
            companyId: contact.company_id,
            campaignId: campaign.campaign_id,
            contactId,
          },
        )
      ).conversation!.id;
    }
    await c.query(
      'insert into conversations(company_id,campaign_id,contact_id,channel) values($1,$2,$3,$4) on conflict do nothing',
      [contact.company_id, campaign.campaign_id, contactId, channel],
    );
    const {
      rows: [conversation],
    } = await c.query(
      'select id from conversations where company_id=$1 and campaign_id=$2 and contact_id=$3 and channel=$4 and provider_thread_id is null',
      [contact.company_id, campaign.campaign_id, contactId, channel],
    );
    return String(conversation.id);
  });
}
async function reply(
  conversationId: string,
  draft: {
    subject?: string;
    body: string;
    socialDelivery?: 'browser' | 'manual';
  },
  key: string | { requestId: string },
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
    const v = await lockConversation(c, conversationId);
    conversationId = v.id;
    const requestKey =
      typeof key === 'string'
        ? key
        : `reply:${conversationId}:${key.requestId}`;
    const priorKeys =
      typeof key === 'string'
        ? [key]
        : (await conversationAliases(c, v)).map(
            (id) => `reply:${id}:${key.requestId}`,
          );
    if (
      !v ||
      !['email', 'telegram', 'whatsapp', ...manualChannels].includes(v.channel)
    )
      invalid('Цей діалог не підтримує відповіді.');
    const socialBrowser =
      v.channel === 'social' && draft.socialDelivery === 'browser';
    if (socialBrowser && (!queued || !userId))
      invalid('Надішліть повідомлення вручну з діалогу.');
    const manual = manualChannels.includes(v.channel) && !socialBrowser;
    if (v.company_id)
      await c.query(
        "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
        [v.company_id],
      );
    let {
      rows: [last],
    } = await c.query(
      `select account_id,to_value,subject from messages where conversation_id=$1 order by (direction='in') desc,${messageHistoryOrder('desc')} limit 1`,
      [conversationId],
    );
    // First message written by hand: recipient from the contact, sender = the active account.
    if (!last && v.contact_id) {
      const {
        rows: [contact],
      } = await c.query(
        'select ct.normalized,ct.value,co.country_code from contacts ct join companies co on co.id=ct.company_id where ct.id=$1',
        [v.contact_id],
      );
      const to =
        v.channel === 'telegram'
          ? normalizeTelegramRecipient(contact?.normalized ?? '')
          : v.channel === 'whatsapp'
            ? normalizeWhatsAppRecipient(
                contact?.normalized ?? '',
                contact?.country_code,
              )
            : (contact?.normalized ?? contact?.value);
      const {
        rows: [account],
      } =
        manual || socialBrowser
          ? { rows: [{ id: null }] }
          : await c.query(
              "select id from channel_accounts where channel=$1 and status='active' order by created_at,id limit 1",
              [v.channel],
            );
      if (!to) invalid('Не вдалося визначити адресу контакту.');
      if (!account) invalid('Підключіть активний акаунт для цього каналу.');
      last = { account_id: account.id, to_value: to, subject: '' };
    }
    if (!last || (await isContactBlocked(c, v.company_id, last.to_value)))
      invalid('Контакт у списку «Не контактувати».');
    let receivingMeta: Record<string, unknown> | null = null;
    if (v.channel === 'social' && v.provider_thread_id && v.account_id) {
      const {
        rows: [receiving],
      } = await c.query(
        "select id from channel_accounts where id=$1 and channel='facebook'",
        [v.account_id],
      );
      if (receiving) {
        const peer = canonicalSocialPeer(
          'facebook',
          v.peer_value ?? last.to_value,
        );
        await assertFacebookBinding(
          c,
          conversationId,
          receiving.id,
          peer,
          v.provider_thread_id,
        );
        last.account_id = receiving.id;
        last.to_value = peer;
        receivingMeta = {
          network: 'facebook',
          peerProfile: peer,
          threadId: v.provider_thread_id,
        };
      }
    }
    const { rows: priorMessages } = await c.query(
      'select id,status,conversation_id,body,source from messages where idempotency_key=any($1::text[]) order by created_at,id',
      [priorKeys],
    );
    const prior = priorMessages[0];
    if (prior) {
      if (
        priorMessages.some(
          (message) =>
            message.conversation_id !== conversationId ||
            message.body !== draft.body.trim() ||
            (v.channel === 'social' &&
              (message.source === 'reply') !== socialBrowser),
        )
      )
        invalid('Ключ повідомлення вже використано для іншого запиту.');
      return { id: String(prior.id), status: String(prior.status) };
    }
    if (socialBrowser) {
      const target = socialTarget(last.to_value);
      if (
        !target ||
        target.kind === 'unsupported' ||
        (target.network === 'linkedin' && target.kind !== 'company')
      )
        invalid('Цей профіль не підтримує надсилання повідомлень.');
      const {
        rows: [account],
      } = await c.query(
        "select id from channel_accounts where channel=$1 and status='active' and settings->>'sessionStatus'='valid' and ($2::uuid is null or id=$2) order by created_at,id limit 1",
        [target!.network, v.provider_thread_id ? v.account_id : null],
      );
      if (!account) invalid('Підключіть активний акаунт для цієї соцмережі.');
      last.account_id = account.id;
    } else if (v.channel === 'social' && !receivingMeta) last.account_id = null;
    const subject =
      draft.subject?.trim() ||
      last.subject ||
      (v.channel === 'email' ? 'Re:' : '');
    const {
      rows: [m],
    } = await c.query(
      `insert into messages(conversation_id,account_id,channel,source,to_value,subject,body,status,idempotency_key,created_by,approved_by,approved_at,scheduled_at,sent_at,social_meta) values($1,$2,$3,$11,$4,$5,$6,$7,$8,$9,$9,case when $10 then now() end,case when $10 then now() end,case when $7='sent' then now() end,$12) returning id,status`,
      [
        conversationId,
        last.account_id,
        v.channel,
        last.to_value,
        subject,
        draft.body.trim(),
        // Forms and social networks are sent by a person; the message records that.
        queued ? (manual ? 'sent' : 'queued') : 'draft',
        requestKey,
        userId,
        queued,
        manual ? 'manual' : 'reply',
        receivingMeta,
      ],
    );
    if (queued && !manual)
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
    socialDelivery?: 'browser' | 'manual';
  },
  userId: string,
) {
  if (!input.requestId || input.requestId.length > 100)
    invalid('Вкажіть ключ повідомлення.');
  return reply(
    input.conversationId,
    input,
    { requestId: input.requestId },
    userId,
    true,
  );
}

/** Owner-only repair is queued, and the provider lookup happens in the worker. */
export async function getWhatsAppRepairPeer(
  conversationId: string,
  userId: string,
) {
  const { rows } = await sonarPool.query(
    `select distinct a.id as account_id,v.peer_value from conversations v
    join channel_accounts a on a.id=coalesce(v.account_id,(select m.account_id from messages m where m.conversation_id=v.id limit 1))
    where v.id=$1 and v.channel='whatsapp' and a.channel='whatsapp' and a.owner_id=$2 and a.settings->>'session'='default'
      and (select count(*) from channel_accounts where channel='whatsapp' and settings->>'session'='default')=1
      and not exists(select 1 from messages m where m.conversation_id=v.id and m.account_id is distinct from a.id)`,
    [conversationId, userId],
  );
  if (
    rows.length !== 1 ||
    !/^whatsapp:lid:[1-9]\d*$/.test(rows[0].peer_value ?? '')
  )
    invalid('Для ремонту оберіть LID-діалог власного акаунта WhatsApp.');
  return rows[0] as { account_id: string; peer_value: string };
}
export async function enqueueWhatsAppIdentityRepair(
  conversationId: string,
  userId: string,
  requestId: string,
  dryRun: boolean,
) {
  await getWhatsAppRepairPeer(conversationId, userId);
  const key = `whatsapp.identity.repair:${conversationId}:${requestId}`;
  const created = await enqueueTask('whatsapp.identity.repair', key, {
    conversationId,
    userId,
    dryRun,
  });
  if (created) return { taskId: created };
  const {
    rows: [prior],
  } = await sonarPool.query(
    'select id,payload from tasks where idempotency_key=$1',
    [key],
  );
  if (
    !prior ||
    prior.payload.userId !== userId ||
    prior.payload.dryRun !== dryRun
  )
    invalid('Ключ ремонту вже використано для іншого запиту.');
  return { taskId: prior.id as string };
}
export async function repairWhatsAppIdentity(
  conversationId: string,
  userId: string,
  phone: string,
  dryRun: boolean,
) {
  const peer = await getWhatsAppRepairPeer(conversationId, userId);
  return transaction(async (c) => {
    await lockWhatsAppIdentity(c, peer.account_id);
    const {
      rows: [owner],
    } = await c.query(
      "select id from channel_accounts where id=$1 and owner_id=$2 and channel='whatsapp' and settings->>'session'='default'",
      [peer.account_id, userId],
    );
    if (!owner) invalid('Акаунт WhatsApp недоступний.');
    const proposal = await whatsappConversation(
      c,
      peer.account_id,
      peer.peer_value,
      phone,
      {},
      true,
    );
    const result =
      dryRun || proposal.ambiguous
        ? proposal
        : await whatsappConversation(
            c,
            peer.account_id,
            peer.peer_value,
            phone,
          );
    return {
      dryRun,
      ambiguous: result.ambiguous,
      conversationId: result.conversation?.id ?? null,
      mergedIds: result.mergedIds,
    };
  });
}
