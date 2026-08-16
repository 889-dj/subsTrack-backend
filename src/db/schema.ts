import { index, pgTable, text, timestamp, uuid, numeric, varchar, uniqueIndex } from 'drizzle-orm/pg-core';
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
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('subscriptions_user_id_idx').on(t.userId),
    index('subscriptions_next_renewal_date_idx').on(t.nextRenewalDate),
  ],
);

/**
 * Real charge history — the replacement for the client-side
 * `synthesizePaymentHistory()` (per docs/backend-prd.md §5/§7). Rows are
 * materialized from each subscription's cadence on create/update (see
 * src/billing.ts) so the detail screen has real history immediately; the
 * unique (subscription_id, charged_at) pair keeps backfills idempotent.
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

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
