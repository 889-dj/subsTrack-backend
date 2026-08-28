import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { BILLING_CYCLES, SUBSCRIPTION_STATUSES } from '../constants.js';

/**
 * Data model per docs/backend-prd.md.
 *
 * - users.id is the Clerk `sub` claim — we never mint our own user ids.
 * - Money is numeric(12,2), never float.
 * - Every row in subscriptions belongs to exactly one user and every query is
 *   scoped by user_id (ownership is enforced in SQL, not app code).
 */

export const users = pgTable('users', {
  id: text('id').primaryKey(), // Clerk sub
  email: text('email').notNull(),
  proUntil: timestamp('pro_until', { withTimezone: true, mode: 'date' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // numeric with mode 'number' so the API round-trips cost as a JSON number,
    // exactly like the mobile client's Subscription type.
    cost: numeric('cost', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }).notNull(),
    // Full ISO instant (like the mock, which stores toISOString()). The
    // client groups by its *local* calendar day, so truncating to a UTC date
    // here would shift renewals a day early for non-UTC users.
    nextRenewalDate: timestamp('next_renewal_date', { withTimezone: true, mode: 'date' }).notNull(),
    category: text('category'),
    source: text('source'),
    plan: text('plan'),
    note: text('note'),
    // Resolved once at create/rename time (see src/logo.ts) rather than
    // derived on every read — keeps GET fast and independent of a third
    // party's uptime. Null for rows created before this column existed.
    logoUrl: text('logo_url'),
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('subscriptions_user_id_idx').on(t.userId),
    index('subscriptions_next_renewal_date_idx').on(t.nextRenewalDate),
    index('subscriptions_user_status_renewal_idx').on(t.userId, t.status, t.nextRenewalDate),
    check('subscriptions_cost_positive', sql`${t.cost} > 0`),
    check('subscriptions_billing_cycle_check', sql`${t.billingCycle} in ('monthly', 'yearly')`),
    check('subscriptions_status_check', sql`${t.status} in ('active', 'paused', 'cancelled')`),
    check(
      'subscriptions_currency_check',
      sql`${t.currency} in ('INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY')`,
    ),
  ],
);

/**
 * Legacy table retained for migration compatibility. The current product has
 * no verified transaction feed, so it does not insert inferred rows here or
 * expose them as payment history. Forecasts are computed separately and are
 * explicitly labelled as estimates by the API.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 12, scale: 2, mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    // The instant the charge was (or will be) taken. Backfill only inserts
    // dates in the past; future dates are reserved for real charge capture.
    chargedAt: timestamp('charged_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payments_subscription_charged_at_idx').on(t.subscriptionId, t.chargedAt),
  ],
);

/** Durable idempotency and diagnostics for at-least-once webhook delivery. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: varchar('provider', { length: 24 }).notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).default('received').notNull(),
    attempts: integer('attempts').default(1).notNull(),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('webhook_events_provider_event_idx').on(t.provider, t.providerEventId)],
);

/** Server-side projection of RevenueCat's authoritative entitlement state. */
export const entitlements = pgTable(
  'entitlements',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entitlementId: text('entitlement_id').notNull(),
    isActive: boolean('is_active').default(false).notNull(),
    productId: text('product_id'),
    store: text('store'),
    environment: text('environment'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    originalAppUserId: text('original_app_user_id'),
    sourceEventAt: timestamp('source_event_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.entitlementId] })],
);

/**
 * Durable deletion outbox. It has no user FK so it survives local identity
 * deletion until Clerk and RevenueCat are both cleaned up.
 */
export const deletionJobs = pgTable(
  'deletion_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('deletion_jobs_user_id_idx').on(t.userId),
    index('deletion_jobs_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type EntitlementRow = typeof entitlements.$inferSelect;
export type DeletionJobRow = typeof deletionJobs.$inferSelect;
