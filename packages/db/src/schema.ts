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
} from 'drizzle-orm/pg-core';
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
    monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 20, scale: 10 }),
    note: text('note'),
  },
  (table) => [
    check('service_limit_nonnegative', sql`${table.monthlyLimitUsd} >= 0`),
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
