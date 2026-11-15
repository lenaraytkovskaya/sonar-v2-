import type { PoolClient } from 'pg';
import { normalizeWhatsAppRecipient } from '@sonar/core/whatsapp';
import { EmailValidationError } from './email.js';
import { logActivity } from './tasks.js';

type Conversation = {
  id: string;
  company_id: string | null;
  campaign_id: string | null;
  contact_id: string | null;
  account_id: string | null;
  peer_value: string | null;
  peer_aliases: string[];
  values: string[];
};
type Context = {
  companyId?: string | null;
  campaignId?: string | null;
  contactId?: string | null;
};
export async function lockWhatsAppIdentity(c: PoolClient, accountId: string) {
  // Same lock as sending: repairs cannot race a provider attempt.
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [accountId],
  );
}
export async function canonicalConversation(
  c: Pick<PoolClient, 'query'>,
  id: string,
): Promise<string> {
  const { rows } = await c.query(
    `with recursive chain as (
    select id,merged_into_id from conversations where id=$1
    union all select v.id,v.merged_into_id from conversations v join chain p on v.id=p.merged_into_id
  ) select id from chain where merged_into_id is null`,
    [id],
  );
  return rows[0]?.id ?? id;
}
/** Lock order for mutations: receiving account (WhatsApp), company, conversation, messages/tasks. */
export async function lockConversation(c: PoolClient, id: string) {
  // Resolve the account and current root in one snapshot; a merge may commit before the lock arrives.
  const {
    rows: [identity],
  } = await c.query(
    `with recursive chain as (
    select id,merged_into_id from conversations where id=$1
    union all select v.id,v.merged_into_id from conversations v join chain p on v.id=p.merged_into_id
  ) select v.id,v.channel,v.account_id,array_remove(array_agg(distinct m.account_id),null) as accounts
    from chain p join conversations v on v.id=p.id and p.merged_into_id is null
    left join messages m on m.conversation_id=v.id group by v.id`,
    [id],
  );
  if (!identity) throw new EmailValidationError('Діалог не знайдено.');
  let accountId: string | undefined;
  if (identity.channel === 'whatsapp') {
    const accounts = [
      ...new Set<string>(
        [identity.account_id, ...identity.accounts].filter(Boolean),
      ),
    ];
    if (accounts.length > 1)
      throw new EmailValidationError(
        'Діалог WhatsApp містить різні акаунти. Потрібна перевірка.',
      );
    accountId = accounts[0];
    if (!accountId) {
      const { rows: active } = await c.query(
        "select id from channel_accounts where channel='whatsapp' and status='active'",
      );
      if (active.length !== 1)
        throw new EmailValidationError(
          'Оберіть однозначний активний акаунт WhatsApp.',
        );
      accountId = active[0].id;
    }
    await lockWhatsAppIdentity(c, accountId!);
  }
  const canonicalId = await canonicalConversation(c, id);
  const {
    rows: [scope],
  } = await c.query('select company_id from conversations where id=$1', [
    canonicalId,
  ]);
  if (!scope) throw new EmailValidationError('Діалог не знайдено.');
  // Generated writers take this lock before their conversation upsert. Never reverse that order.
  if (scope.company_id)
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
      [scope.company_id],
    );
  const {
    rows: [conversation],
  } = await c.query('select * from conversations where id=$1 for update', [
    canonicalId,
  ]);
  if (!conversation) throw new EmailValidationError('Діалог не знайдено.');
  // Do not acquire a different company lock after the row if a non-WhatsApp writer changed its scope.
  if (conversation.company_id !== scope.company_id)
    throw new EmailValidationError(
      'Контекст діалогу змінено. Оновіть діалог перед повтором.',
    );
  if (
    accountId &&
    conversation.account_id &&
    conversation.account_id !== accountId
  )
    throw new EmailValidationError(
      'Діалог WhatsApp містить різні акаунти. Потрібна перевірка.',
    );
  return conversation;
}
/** Call after lockConversation so redirects cannot change while deriving durable intent keys. */
export async function conversationAliases(
  c: PoolClient,
  conversation: { id: string; channel: string },
): Promise<string[]> {
  if (conversation.channel !== 'whatsapp') return [conversation.id];
  const { rows } = await c.query(
    `with recursive aliases as (
    select id from conversations where id=$1
    union all select v.id from conversations v join aliases a on v.merged_into_id=a.id
  ) select id from aliases`,
    [conversation.id],
  );
  return rows.map((row) => row.id);
}
/** Exact normalized identities only. A phone argument must come from WAHA's LID mapping. */
export async function whatsappConversation(
  c: PoolClient,
  accountId: string,
  raw: string,
  phone?: string,
  context: Context = {},
  dryRun = false,
) {
  await lockWhatsAppIdentity(c, accountId);
  const sender = normalizeWhatsAppRecipient(raw);
  if (!sender) throw new EmailValidationError('Некоректна адреса WhatsApp.');
  const mapped =
    sender.startsWith('whatsapp:lid:') && phone
      ? normalizeWhatsAppRecipient(phone)
      : null;
  const {
    rows: [account],
  } = await c.query(
    "select address from channel_accounts where id=$1 and channel='whatsapp'",
    [accountId],
  );
  if (!account) throw new EmailValidationError('Акаунт WhatsApp не знайдено.');
  // Some WAHA versions returned the receiving account's phone for a remote LID.
  const ownPhoneMapping =
    !!mapped && mapped === normalizeWhatsAppRecipient(account.address);
  const aliases = new Set([
    sender,
    ...(mapped?.startsWith('+') && !ownPhoneMapping ? [mapped] : []),
  ]);
  const { rows } = await c.query<Conversation>(
    `select v.*,array_remove(array_agg(distinct m.to_value),null) || array[ct.normalized] as values
    from conversations v left join messages m on m.conversation_id=v.id
    left join contacts ct on ct.id=v.contact_id
    where v.channel='whatsapp' and v.merged_into_id is null
      and (v.account_id=$1 or (v.account_id is null and not exists(select 1 from messages x where x.conversation_id=v.id and x.account_id is distinct from $1)))
      and not exists(select 1 from messages x where x.conversation_id=v.id and x.account_id is distinct from $1)
    group by v.id,ct.normalized order by (v.company_id is not null) desc,v.created_at,v.id`,
    [accountId],
  );
  const identities = (row: Conversation) => [
    ...new Set(
      [row.peer_value, ...row.peer_aliases, ...row.values]
        .map((v) => v && normalizeWhatsAppRecipient(v))
        .filter((v): v is string => !!v),
    ),
  ];
  let candidates = rows.filter((row) =>
    identities(row).some((value) => aliases.has(value)),
  );
  const companies = new Set(
    [context.companyId, ...candidates.map((r) => r.company_id)].filter(Boolean),
  );
  const campaigns = new Set(
    [context.campaignId, ...candidates.map((r) => r.campaign_id)].filter(
      Boolean,
    ),
  );
  const phones = new Set(
    [...aliases, ...candidates.flatMap(identities)].filter((v) =>
      v.startsWith('+'),
    ),
  );
  const ambiguous =
    ownPhoneMapping ||
    companies.size > 1 ||
    campaigns.size > 1 ||
    phones.size > 1;
  if (ambiguous) {
    // Keep the opaque peer unknown instead of attaching it to an arbitrary company.
    candidates = candidates.filter((row) => row.peer_value === sender);
    aliases.clear();
    aliases.add(sender);
    if (context.companyId)
      throw new EmailValidationError(
        'Адреса WhatsApp має неоднозначні діалоги. Потрібна перевірка.',
      );
  }
  // A campaign-less canonical row must inherit the proven campaign, including its send restrictions.
  if (!ambiguous && campaigns.size === 1)
    context = { ...context, campaignId: [...campaigns][0] };
  const mappingNew =
    !!mapped &&
    !ambiguous &&
    !candidates.some(
      (row) =>
        row.peer_aliases.includes(sender) && row.peer_aliases.includes(mapped),
    );
  let conversation = candidates[0];
  const mergedIds = candidates.slice(1).map((r) => r.id);
  if (!ambiguous && !context.companyId && !conversation?.company_id) {
    const { rows: contacts } = await c.query(
      "select id,company_id,normalized from contacts where kind in ('phone','whatsapp')",
    );
    const matches = contacts.filter((row) =>
      aliases.has(normalizeWhatsAppRecipient(row.normalized) ?? ''),
    );
    if (new Set(matches.map((row) => row.company_id)).size === 1) {
      context = {
        ...context,
        companyId: matches[0].company_id,
        contactId: matches[0].id,
      };
      const { rows: campaigns } = await c.query(
        'select campaign_id from campaign_companies where company_id=$1',
        [context.companyId],
      );
      if (!context.campaignId && campaigns.length === 1)
        context.campaignId = campaigns[0].campaign_id;
    }
  }
  if (dryRun)
    return { conversation, mergedIds, ambiguous, aliases: [...aliases] };
  // Match sending and blockCompany lock order before touching message rows.
  const companyLocks = [
    ...new Set(
      [context.companyId, ...candidates.map((row) => row.company_id)].filter(
        (id): id is string => !!id,
      ),
    ),
  ].sort();
  for (const companyId of companyLocks)
    await c.query(
      "select pg_advisory_xact_lock(hashtextextended('company-contact:'||$1::text,0))",
      [companyId],
    );
  if (!conversation) {
    const companyId = context.companyId ?? null;
    const contactId = context.contactId ?? null;
    const { rows: created } = await c.query<Conversation>(
      `insert into conversations(company_id,campaign_id,contact_id,channel,account_id,peer_value,peer_aliases) values($1,$2,$3,'whatsapp',$4,$5,$6) returning *`,
      [
        companyId ?? null,
        context.campaignId ?? null,
        contactId ?? null,
        accountId,
        sender,
        [...aliases],
      ],
    );
    conversation = created[0]!;
  }
  if (!conversation) throw new Error('WhatsApp conversation was not created');
  for (const row of candidates)
    for (const alias of identities(row)) aliases.add(alias);
  if (mergedIds.length) {
    // Keep the old rows as durable redirects. Message IDs, statuses and task keys stay intact.
    await c.query(
      'update conversations set merged_into_id=$2 where id=any($1::uuid[])',
      [mergedIds, conversation.id],
    );
    await c.query('update conversations set account_id=$2 where id=$1', [
      conversation.id,
      accountId,
    ]);
    await c.query(
      'update messages set conversation_id=$2 where conversation_id=any($1::uuid[])',
      [mergedIds, conversation.id],
    );
  }
  const companyId = conversation.company_id ?? context.companyId ?? null;
  await c.query(
    'update conversations set account_id=$2,peer_aliases=$3,company_id=coalesce(company_id,$4),campaign_id=coalesce(campaign_id,$5),contact_id=coalesce(contact_id,$6) where id=$1',
    [
      conversation.id,
      accountId,
      [...aliases],
      companyId,
      context.campaignId ?? null,
      context.contactId ?? null,
    ],
  );
  // Legacy AI task payloads keep old conversation IDs; their budget lookup must keep the same cap.
  const campaignId = conversation.campaign_id ?? context.campaignId ?? null;
  if (campaignId) {
    const linked = await conversationAliases(c, {
      id: conversation.id,
      channel: 'whatsapp',
    });
    await c.query(
      'update conversations set campaign_id=$2 where id=any($1::uuid[]) and campaign_id is null',
      [linked, campaignId],
    );
  }
  // A refusal under any spelling still blocks every proven spelling and the linked company.
  const { rows: blocks } = await c.query(
    'select value_normalized,company_id from do_not_contact',
  );
  const { rows: refusals } = await c.query(
    "select 1 from messages where conversation_id=$1 and classification='refusal' limit 1",
    [conversation.id],
  );
  if (
    refusals.length ||
    blocks.some(
      (row) =>
        (companyId && row.company_id === companyId) ||
        aliases.has(normalizeWhatsAppRecipient(row.value_normalized) ?? ''),
    )
  ) {
    for (const alias of aliases)
      await c.query(
        `insert into do_not_contact(company_id,kind,value_normalized,reason) values($1,'whatsapp',$2,'Підтверджена тотожність контакту зі стоп-списку.') on conflict(kind,value_normalized) do nothing`,
        [companyId, alias],
      );
    if (companyId)
      await c.query(
        `insert into do_not_contact(company_id,kind,value_normalized,reason) values($1::uuid,'company',$1::text,'Підтверджена тотожність контакту зі стоп-списку.') on conflict(kind,value_normalized) do nothing`,
        [companyId],
      );
  }
  if (refusals.length && companyId)
    await c.query(
      "update companies set status='refused',updated_at=now() where id=$1",
      [companyId],
    );
  if (mappingNew)
    await logActivity(
      'whatsapp.identity.resolved',
      'conversation',
      conversation.id,
      null,
      { accountId, aliases: [...aliases], source: 'waha.lids' },
      c,
    );
  if (mergedIds.length)
    await logActivity(
      'whatsapp.identity.reconciled',
      'conversation',
      conversation.id,
      null,
      {
        mergedIds,
        accountId,
        source: mapped ? 'waha.lids' : 'normalized_address',
      },
      c,
    );
  return {
    conversation: {
      ...conversation,
      company_id: companyId,
      campaign_id: conversation.campaign_id ?? context.campaignId ?? null,
    },
    mergedIds,
    ambiguous,
    aliases: [...aliases],
  };
}
