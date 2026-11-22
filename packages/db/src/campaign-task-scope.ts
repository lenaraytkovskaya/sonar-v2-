import { campaignPauseTypes } from '@sonar/core';
const sharedTypes = [...campaignPauseTypes('company'), 'google.company']
  .map((type) => `'${type}'`)
  .join(',');
// Parameters and aliases are internal SQL, never request text. Explicit ownership
// wins in this order: real batch, campaign ID, payload batch, message, conversation.
// Unknown/malformed explicit owners never fall through to a shared company.
export function campaignTaskScope(parameter = '$1', shared = true) {
  const campaign = `${parameter}::uuid`;
  return `(case
    when t.batch_id is not null then exists(select 1 from batches b where b.id=t.batch_id and b.campaign_id=${campaign})
    when nullif(t.payload->>'campaignId','') is not null then lower(t.payload->>'campaignId')=${campaign}::text
    when nullif(t.payload->>'batchId','') is not null then exists(select 1 from batches b where b.id::text=lower(t.payload->>'batchId') and b.campaign_id=${campaign})
    when nullif(t.payload->>'messageId','') is not null then exists(select 1 from messages m join conversations v on v.id=m.conversation_id where m.id::text=lower(t.payload->>'messageId') and v.campaign_id=${campaign})
    when nullif(t.payload->>'conversationId','') is not null then exists(select 1 from conversations v where v.id::text=lower(t.payload->>'conversationId') and v.campaign_id=${campaign})
    else ${shared ? `(t.type in (${sharedTypes}) and exists(select 1 from campaign_companies cc where cc.campaign_id=${campaign} and cc.company_id::text=lower(coalesce(nullif(t.payload->>'companyId',''),case when t.subject_type='company' then t.subject_id end))))` : 'false'}
  end)`;
}
