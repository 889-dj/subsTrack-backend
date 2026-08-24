import { createHash } from 'node:crypto';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';

export type WebhookProvider = 'clerk' | 'revenuecat';

export function payloadHash(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** Returns false when this delivery is already processed or currently owned. */
export async function claimWebhookEvent(input: {
  provider: WebhookProvider;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
}): Promise<boolean> {
  const [inserted] = await db
    .insert(webhookEvents)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted) return true;

  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const [retry] = await db
    .update(webhookEvents)
    .set({
      status: 'received',
      attempts: sql`${webhookEvents.attempts} + 1`,
      lastError: null,
      receivedAt: new Date(),
    })
    .where(
      and(
        eq(webhookEvents.provider, input.provider),
        eq(webhookEvents.providerEventId, input.providerEventId),
        or(
          eq(webhookEvents.status, 'failed'),
          and(
            eq(webhookEvents.status, 'received'),
            lt(webhookEvents.receivedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: webhookEvents.id });
  return Boolean(retry);
}

export async function markWebhookProcessed(
  provider: WebhookProvider,
  providerEventId: string,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status: 'processed', processedAt: new Date(), lastError: null })
    .where(
      and(
        eq(webhookEvents.provider, provider),
        eq(webhookEvents.providerEventId, providerEventId),
      ),
    );
}

export async function markWebhookFailed(
  provider: WebhookProvider,
  providerEventId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown webhook error';
  await db
    .update(webhookEvents)
    .set({ status: 'failed', lastError: message })
    .where(
      and(
        eq(webhookEvents.provider, provider),
        eq(webhookEvents.providerEventId, providerEventId),
      ),
    );
}
