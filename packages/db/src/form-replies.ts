import type { PoolClient } from 'pg';
import type { ReplyMatchCompany } from '@sonar/core';
import { sonarPool } from './index.js';
import { transaction, EmailValidationError } from './email.js';
import {
  canonicalConversation,
  lockConversation,
} from './whatsapp-identity.js';
import { enqueueTask, logActivity } from './tasks.js';

export type FormReplyMatch = {
  state: 'bound' | 'suggested' | 'unbound' | 'rejected';
  companyId: string | null;
  suggestedCompanyId: string | null;
  method: 'automatic' | 'ai' | 'manual';
  confidence: number | null;
  reasonUk: string;
  formMessageId: string | null;
  suppressed?: boolean;
  originalCompanyId?: string | null;
  originalCampaignId?: string | null;
  originalContactId?: string | null;
  taskId?: string | null;
  companyName?: string | null;
  suggestedCompanyName?: string | null;
};
export async function enqueueFormReplyMatch(
  c: PoolClient,
  conversationId: string,
  messageId: string,
  senderPhone?: string,
) {
  await enqueueTask(
    'form.reply.match',
    `form.reply.match:${messageId}`,
    { conversationId, messageId, ...(senderPhone ? { senderPhone } : {}) },
    c,
  );
}
/** Serializes competing inbound match jobs while leaving human choices responsive. */
export async function withFormReplyMatchLock<T>(
  conversationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const c = await sonarPool.connect();
  let key: string | undefined;
  try {
    key = `form-reply-match:${await canonicalConversation(c, conversationId)}`;
    await c.query('select pg_advisory_lock(hashtextextended($1,0))', [key]);
    return await work();
  } finally {
    try {
      if (key)
        await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [
          key,
        ]);
    } finally {
      c.release();
    }
  }
}
export async function getFormReplyMatch(
  conversationId: string,
): Promise<FormReplyMatch | null> {
  conversationId = await canonicalConversation(sonarPool, conversationId);
  const {
    rows: [row],
  } = await sonarPool.query(
    `select v.form_reply_match as match,c.name as "companyName",s.name as "suggestedCompanyName"
     from conversations v left join companies c on c.id::text=v.form_reply_match->>'companyId'
     left join companies s on s.id::text=v.form_reply_match->>'suggestedCompanyId' where v.id=$1`,
    [conversationId],
  );
  return row?.match
    ? {
        ...row.match,
        companyName: row.companyName,
        suggestedCompanyName: row.suggestedCompanyName,
      }
    : null;
}
export async function getFormReplyContext(
  conversationId: string,
  messageId: string,
) {
  conversationId = await canonicalConversation(sonarPool, conversationId);
  const {
    rows: [row],
  } = await sonarPool.query(
    `select v.id,v.company_id as "companyId",v.form_reply_match as match,m.channel,m.to_value as sender,m.body,m.subject
     from conversations v join messages m on m.conversation_id=v.id where v.id=$1 and m.id=$2 and m.direction='in'`,
    [conversationId, messageId],
  );
  return row ?? null;
}
export async function getReplyMatchCompanies(): Promise<ReplyMatchCompany[]> {
  return (
    await sonarPool.query(
      `select c.id,c.website,coalesce(ca.country_code,c.country_code) as "countryCode",
     coalesce((select jsonb_agg(jsonb_build_object('kind',ct.kind,'value',ct.value)) from contacts ct
       where ct.company_id=c.id and ct.kind in ('email','phone','whatsapp','telegram')),'[]'::jsonb) as contacts
     from companies c left join lateral(select a.country_code from campaign_companies cc
       join campaigns a on a.id=cc.campaign_id where cc.company_id=c.id order by cc.added_at desc,cc.campaign_id limit 1) ca on true`,
    )
  ).rows;
}
export type FormReplyCandidate = {
  companyId: string;
  formMessageId: string;
  campaignId: string;
  name: string;
  city: string | null;
  website: string | null;
  message: string;
};
export async function getFormReplyCandidates(
  channel: string,
  days: number,
  limit: number,
  chars: number,
): Promise<FormReplyCandidate[]> {
  if (channel === 'social') {
    return (
      await sonarPool.query(
        `select distinct on(v.company_id) v.company_id as "companyId",m.id as "formMessageId",v.campaign_id as "campaignId",
        c.name,c.city,c.website,left(m.body,$2) as message
       from messages m join conversations v on v.id=m.conversation_id join companies c on c.id=v.company_id
       where m.channel in ('social','form') and m.direction='out' and m.status in ('sent','delivered','read')
         and coalesce(m.sent_at,m.created_at)>=now()-interval '30 days'
       order by v.company_id,coalesce(m.sent_at,m.created_at) desc,m.id limit $1`,
        [limit, chars],
      )
    ).rows;
  }
  const channels = channel === 'whatsapp' ? ['whatsapp', 'phone'] : [channel];
  return (
    await sonarPool.query(
      `select distinct on(v.company_id) v.company_id as "companyId",m.id as "formMessageId",v.campaign_id as "campaignId",
      c.name,c.city,c.website,left(coalesce(m.request_snapshot->>'body',m.body),$4) as message
     from messages m join conversations v on v.id=m.conversation_id join companies c on c.id=v.company_id
     where m.channel='form' and m.direction='out' and m.status in ('sent','delivered','read')
       and m.sent_at>=now()-$1*interval '1 day' and m.request_snapshot->'sharedContacts' ?| $2::text[]
     order by v.company_id,m.sent_at desc,m.id limit $3`,
      [days, channels, limit, chars],
    )
  ).rows;
}
export async function bindFormReplyConversation(input: {
  conversationId: string;
  companyId: string;
  actorId?: string | null;
  method?: FormReplyMatch['method'];
  reasonUk?: string;
  confidence?: number | null;
  taskId?: string;
  formMessageId?: string | null;
}) {
  return transaction(async (c) => {
    const v = await lockConversation(c, input.conversationId);
    const previous = v.form_reply_match as FormReplyMatch | null;
    const method = input.method ?? 'manual';
    if (
      previous?.state === 'bound' &&
      v.company_id === input.companyId &&
      previous.companyId === input.companyId &&
      previous.method === method
    )
      return true;
    if (method !== 'manual' && (v.company_id || previous?.suppressed))
      return false;
    if (
      v.company_id &&
      (previous?.state !== 'bound' || v.company_id !== previous.companyId)
    )
      throw new EmailValidationError('Діалог уже прив’язано до компанії.');
    const {
      rows: [company],
    } = await c.query('select id from companies where id=$1', [
      input.companyId,
    ]);
    if (!company) throw new EmailValidationError('Компанію не знайдено.');
    const {
      rows: [form],
    } = await c.query(
      `select m.id,v.campaign_id from messages m join conversations v on v.id=m.conversation_id
       where v.company_id=$1 and m.channel in ('form','social') and m.direction='out' and m.status in ('sent','delivered','read')
       and ($2::uuid is null or m.id=$2) order by m.sent_at desc nulls last,m.id limit 1`,
      [input.companyId, input.formMessageId ?? null],
    );
    if (input.formMessageId && !form)
      throw new EmailValidationError('Надіслану форму більше не знайдено.');
    const {
      rows: [campaign],
    } = form
      ? { rows: [] }
      : await c.query(
          'select campaign_id from campaign_companies where company_id=$1 order by added_at desc,campaign_id limit 1',
          [input.companyId],
        );
    const match: FormReplyMatch = {
      state: 'bound',
      companyId: input.companyId,
      suggestedCompanyId: null,
      method,
      confidence: input.confidence ?? null,
      reasonUk: input.reasonUk ?? 'Компанію обрано вручну.',
      formMessageId: form?.id ?? null,
      taskId: input.taskId ?? null,
      originalCompanyId: previous?.originalCompanyId ?? null,
      originalCampaignId:
        previous && Object.hasOwn(previous, 'originalCampaignId')
          ? previous.originalCampaignId
          : (v.campaign_id ?? null),
      originalContactId:
        previous && Object.hasOwn(previous, 'originalContactId')
          ? previous.originalContactId
          : (v.contact_id ?? null),
    };
    await c.query(
      'update conversations set company_id=$2,campaign_id=$3,contact_id=null,form_reply_match=$4 where id=$1',
      [
        v.id,
        input.companyId,
        form?.campaign_id ?? campaign?.campaign_id ?? null,
        match,
      ],
    );
    await logActivity(
      'form.reply.bound',
      'conversation',
      v.id,
      input.actorId ?? null,
      { ...match },
      c,
    );
    return true;
  });
}
export async function suggestFormReplyMatch(input: {
  conversationId: string;
  companyId: string;
  reasonUk: string;
  confidence: number;
  formMessageId: string;
  taskId: string;
}) {
  return transaction(async (c) => {
    const v = await lockConversation(c, input.conversationId);
    if (v.company_id || v.form_reply_match?.suppressed) return false;
    const match: FormReplyMatch = {
      state: 'suggested',
      companyId: null,
      suggestedCompanyId: input.companyId,
      method: 'ai',
      confidence: input.confidence,
      reasonUk: input.reasonUk,
      formMessageId: input.formMessageId,
      taskId: input.taskId,
    };
    await c.query('update conversations set form_reply_match=$2 where id=$1', [
      v.id,
      match,
    ]);
    await logActivity(
      'form.reply.suggested',
      'conversation',
      v.id,
      null,
      match,
      c,
    );
    return true;
  });
}
export async function unbindFormReplyConversation(
  conversationId: string,
  actorId: string | null,
) {
  return transaction(async (c) => {
    const v = await lockConversation(c, conversationId);
    const match = v.form_reply_match as FormReplyMatch | null;
    if (match?.state !== 'bound' || match.companyId !== v.company_id)
      return false;
    await c.query(
      'update conversations set company_id=$2,campaign_id=$3,contact_id=$4,form_reply_match=$5 where id=$1',
      [
        v.id,
        match.originalCompanyId ?? null,
        match.originalCampaignId ?? null,
        match.originalContactId ?? null,
        { ...match, state: 'unbound', companyId: null, suppressed: true },
      ],
    );
    await logActivity(
      'form.reply.unbound',
      'conversation',
      v.id,
      actorId,
      match,
      c,
    );
    return true;
  });
}
export async function rejectFormReplySuggestion(
  conversationId: string,
  actorId: string | null,
) {
  return transaction(async (c) => {
    const v = await lockConversation(c, conversationId);
    const match = v.form_reply_match as FormReplyMatch | null;
    if (v.company_id || match?.state !== 'suggested') return false;
    await c.query('update conversations set form_reply_match=$2 where id=$1', [
      v.id,
      { ...match, state: 'rejected', suppressed: true },
    ]);
    await logActivity(
      'form.reply.rejected',
      'conversation',
      v.id,
      actorId,
      match,
      c,
    );
    return true;
  });
}
