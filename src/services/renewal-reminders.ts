import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { subscriptions, users } from '../db/schema.js';
import { sendPushNotification } from './push.js';

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Finds active subscriptions renewing within the next 24h whose owner has a
 * push token, sends one reminder each, and records which nextRenewalDate the
 * reminder was for — so re-running this job (it runs on a fixed interval)
 * never double-sends for the same upcoming renewal. Runs opportunistically:
 * whichever invocation first sees a subscription enter the 24h window sends
 * it, so the interval only needs to be shorter than 24h, not exact.
 */
export async function sendDueRenewalReminders(log: FastifyBaseLogger): Promise<void> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const due = await db
    .select({
      subscriptionId: subscriptions.id,
      name: subscriptions.name,
      cost: subscriptions.cost,
      currency: subscriptions.currency,
      logoUrl: subscriptions.logoUrl,
      nextRenewalDate: subscriptions.nextRenewalDate,
      reminderSentForRenewal: subscriptions.reminderSentForRenewal,
      pushToken: users.pushToken,
    })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(
      and(
        eq(subscriptions.status, 'active'),
        isNotNull(users.pushToken),
        gte(subscriptions.nextRenewalDate, now),
        lte(subscriptions.nextRenewalDate, windowEnd),
      ),
    );

  for (const item of due) {
    if (!item.pushToken) continue;
    // "Already sent for this exact renewal" — comparing a nullable column to
    // itself is awkward in SQL, so the definitive check happens here in JS.
    const alreadySent =
      item.reminderSentForRenewal?.getTime() === item.nextRenewalDate.getTime();
    if (alreadySent) continue;

    const sent = await sendPushNotification(item.pushToken, {
      title: `${item.name} renews soon`,
      body: `${item.name} renews ${item.nextRenewalDate.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} — ${item.currency} ${item.cost.toFixed(2)}.`,
      data: { subscriptionId: item.subscriptionId, type: 'renewal-reminder' },
      imageUrl: item.logoUrl ?? undefined,
    });

    if (sent) {
      await db
        .update(subscriptions)
        .set({ reminderSentForRenewal: item.nextRenewalDate })
        .where(eq(subscriptions.id, item.subscriptionId));
    } else {
      log.warn({ subscriptionId: item.subscriptionId }, 'Renewal reminder push failed to send');
    }
  }
}
