import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  pgEnum,
  numeric,
  check,
  boolean,
  unique,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const taskStatus = pgEnum('task_status', [
  'queued',
  'running',
  'done',
  'skipped',
  'failed',
  'paused',
]);
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  status: taskStatus('status').notNull().default('queued'),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  batchId: uuid('batch_id'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  attempts: integer('attempts').notNull().default(0),
  reasonCode: text('reason_code'),
  reasonUk: text('reason_uk'),
  payload: jsonb('payload').notNull().default({}),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
});
export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const services = pgTable(
  'services',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    plan: text('plan'),
    unitPriceUsd: numeric('unit_price_usd', { precision: 20, scale: 10 }),
    monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 20, scale: 10 }),
    note: text('note'),
  },
  (table) => [
    check('service_limit_nonnegative', sql`${table.monthlyLimitUsd} >= 0`),
    check('service_price_nonnegative', sql`${table.unitPriceUsd} >= 0`),
  ],
);
export const spendEvents = pgTable(
  'spend_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceCode: text('service_code')
      .notNull()
      .references(() => services.code),
    units: numeric('units', { precision: 20, scale: 4 }).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10 }).notNull(),
    taskId: uuid('task_id')
      .unique()
      .references(() => tasks.id),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'spend_nonnegative',
      sql`${table.costUsd} >= 0 and ${table.units} >= 0`,
    ),
  ],
);

export const sendMode = pgEnum('send_mode', ['auto', 'approval', 'manual']);
export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'active',
  'paused',
  'archived',
]);
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    googleProgress: jsonb('google_progress').notNull().default({}),
    fieldProfile: text('field_profile').notNull().default('contacts'),
    countryCode: text('country_code').notNull(),
    languageCode: text('language_code').notNull(),
    cities: text('cities').array().notNull(),
    queries: text('queries').array().notNull(),
    offer: text('offer').notNull(),
    batchSize: integer('batch_size').notNull().default(20),
    budgetUsd: numeric('budget_usd', { precision: 20, scale: 10 }).notNull(),
    channels: jsonb('channels').notNull(),
    sendMode: sendMode('send_mode').notNull().default('approval'),
    scoringWeights: jsonb('scoring_weights').notNull(),
    scoringRevision: integer('scoring_revision').notNull().default(0),
    status: campaignStatus('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('campaign_budget_nonnegative', sql`${t.budgetUsd} >= 0`),
    check('campaign_batch_size', sql`${t.batchSize} in (20,50,100,200)`),
  ],
);
export const campaignPresets = pgTable('campaign_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  data: jsonb('data').notNull(),
});

export const batchStatus = pgEnum('batch_status', [
  'queued',
  'running',
  'done',
  'paused',
  'failed',
]);
export const companyStatus = pgEnum('company_status', [
  'new',
  'enriching',
  'ready',
  'contacted',
  'replied',
  'interested',
  'deal',
  'refused',
  'do_not_contact',
]);
export const contactKind = pgEnum('contact_kind', [
  'email',
  'phone',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
  'website',
]);
export const contactSource = pgEnum('contact_source', [
  'google',
  'website',
  'registry',
  'prozorro',
  'manual',
]);
export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    number: integer('number').notNull(),
    size: integer('size').notNull(),
    status: batchStatus('status').notNull().default('queued'),
    foundNew: integer('found_new').notNull().default(0),
    foundKnown: integer('found_known').notNull().default(0),
    requests: integer('requests').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10 })
      .notNull()
      .default('0'),
    reasonUk: text('reason_uk'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cursor: jsonb('cursor').notNull().default({ pair: 0, page: 0 }),
    config: jsonb('config').notNull(),
    requestKey: uuid('request_key').notNull().unique(),
    fixture: boolean('fixture').notNull().default(false),
  },
  (t) => [unique('batch_number_unique').on(t.campaignId, t.number)],
);
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  placeId: text('place_id').notNull().unique(),
  name: text('name').notNull(),
  primaryType: text('primary_type'),
  types: text('types').array().notNull().default([]),
  address: text('address'),
  city: text('city'),
  countryCode: text('country_code'),
  lat: numeric('lat', { precision: 12, scale: 8 }),
  lng: numeric('lng', { precision: 12, scale: 8 }),
  website: text('website'),
  domain: text('domain'),
  googleMapsUri: text('google_maps_uri'),
  rating: numeric('rating', { precision: 3, scale: 2 }),
  ratingsCount: integer('ratings_count'),
  businessStatus: text('business_status'),
  status: companyStatus('status').notNull().default('new'),
  googleExpiresAt: timestamp('google_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const campaignCompanies = pgTable(
  'campaign_companies',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('campaign_company_unique').on(t.campaignId, t.companyId)],
);
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    kind: contactKind('kind').notNull(),
    value: text('value').notNull(),
    normalized: text('normalized').notNull(),
    source: contactSource('source').notNull(),
    sourceUrl: text('source_url'),
    meta: jsonb('meta').notNull().default({}),
    verified: boolean('verified').notNull().default(false),
    rank: integer('rank').notNull().default(0),
    foundAt: timestamp('found_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('contact_unique').on(t.companyId, t.kind, t.normalized)],
);

export const companyFacts = pgTable(
  'company_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    kind: text('kind').notNull(),
    value: jsonb('value').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    foundAt: timestamp('found_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'company_fact_source',
      sql`${t.source} in ('google','website','registry','prozorro','manual','ai')`,
    ),
    uniqueIndex('company_fact_unique').on(
      t.companyId,
      t.kind,
      t.source,
      sql`md5(${t.value}::text)`,
    ),
  ],
);

export const companyScores = pgTable(
  'company_scores',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    score: numeric('score').notNull(),
    breakdown: jsonb('breakdown').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('company_score_unique').on(t.companyId, t.campaignId),
    check('company_score_range', sql`${t.score} >= 0 and ${t.score} <= 100`),
  ],
);

export const analyses = pgTable(
  'analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10 }).notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('analysis_company_campaign_version').on(
      t.companyId,
      t.campaignId,
      t.version,
    ),
    check('analysis_cost_nonnegative', sql`${t.costUsd} >= 0`),
  ],
);

export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull().default('email'),
    name: text('name').notNull(),
    address: text('address').notNull(),
    ownerId: uuid('owner_id').references(() => users.id),
    status: text('status').notNull().default('active'),
    settings: jsonb('settings').notNull().default({}),
    dailyLimit: integer('daily_limit').notNull(),
    sentDay: text('sent_day'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextSendAt: timestamp('next_send_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('account_daily_limit', sql`${t.dailyLimit} > 0`),
    check(
      'account_channel',
      sql`${t.channel} in ('email','telegram','whatsapp','form')`,
    ),
  ],
);
export const doNotContact = pgTable(
  'do_not_contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id),
    kind: text('kind').notNull(),
    valueNormalized: text('value_normalized').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('do_not_contact_target').on(t.kind, t.valueNormalized),
    check(
      'block_kind',
      sql`${t.kind} in ('company','email','domain','phone','telegram','whatsapp','viber','form')`,
    ),
  ],
);
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    status: text('status').notNull().default('open'),
    channel: text('channel').notNull().default('email'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('conversation_company_campaign_channel').on(
      t.companyId,
      t.campaignId,
      t.channel,
    ),
  ],
);
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => channelAccounts.id),
    direction: text('direction').notNull().default('out'),
    channel: text('channel').notNull().default('email'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    toValue: text('to_value').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('draft'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    screenshotBefore: bytea('screenshot_before'),
    screenshotAfter: bytea('screenshot_after'),
    requestSnapshot: jsonb('request_snapshot'),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    quotaDay: text('quota_day'),
    providerId: text('provider_id'),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    reasonUk: text('reason_uk'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('message_direction', sql`${t.direction} in ('out','in')`),
    check(
      'message_channel',
      sql`${t.channel} in ('email','telegram','whatsapp','form')`,
    ),
    check(
      'message_status',
      sql`${t.status} in ('draft','awaiting_approval','awaiting_manual','queued','sent','delivered','read','failed')`,
    ),
  ],
);
