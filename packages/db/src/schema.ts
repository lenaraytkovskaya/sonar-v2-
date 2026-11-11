import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  pgEnum,
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
