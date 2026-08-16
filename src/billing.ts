import { db } from './db/client.js';
import { payments, type SubscriptionRow } from './db/schema.js';

/**
 * Charge-history math shared by the payments backfill and the spend-trend
 * endpoint. Matches the mobile client's `synthesizePaymentHistory()`
 * (src/utils/subscriptions.ts in the subsTrack app): charges step back from
 * `nextRenewalDate` by the billing interval (30 / 365 days), and only dates
 * that are already in the past count as history. Two bounds the client
 * doesn't need but we do:
 *   - createdAt: the subscription didn't exist before it was created, so no
 *     charges can predate it.
 *   - cap: a decade-old monthly sub would otherwise materialize 120+ rows;
 *     the detail screen only ever shows a handful.
 */

const DAY = 24 * 60 * 60 * 1000;
const PAYMENT_CAP = 240;

export function chargeTimestamps(sub: {
  createdAt: Date;
  nextRenewalDate: Date;
  billingCycle: SubscriptionRow['billingCycle'];
}): number[] {
  const intervalMs = sub.billingCycle === 'yearly' ? 365 * DAY : 30 * DAY;
  const next = sub.nextRenewalDate.getTime();
  const since = sub.createdAt.getTime();
  const now = Date.now();

  const stamps: number[] = [];
  // First charge is one interval before the next renewal, then step back.
  for (let t = next - intervalMs; t >= since && stamps.length < PAYMENT_CAP; t -= intervalMs) {
    if (t <= now) stamps.push(t);
  }
  return stamps;
}

/**
 * Materialize past charges for a subscription into the `payments` table.
 * Idempotent: the unique (subscription_id, charged_at) constraint means
 * re-running (e.g. after an edit) never duplicates or rewrites history.
 */
export async function backfillPayments(sub: SubscriptionRow): Promise<void> {
  const rows = chargeTimestamps(sub).map((t) => ({
    subscriptionId: sub.id,
    amount: sub.cost,
    currency: sub.currency,
    chargedAt: new Date(t),
  }));
  if (rows.length === 0) return;
  await db.insert(payments).values(rows).onConflictDoNothing();
}
