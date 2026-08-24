import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entitlements, users } from '../db/schema.js';
import { env } from '../config.js';
import { sendError } from '../errors.js';
import {
  claimWebhookEvent,
  markWebhookFailed,
  markWebhookProcessed,
  payloadHash,
} from '../services/webhook-events.js';

/**
 * RevenueCat webhook — keeps `users.pro_until` (the server-side copy of the
 * Pro entitlement, surfaced via `isPro` on GET /v1/me) in sync with
 * RevenueCat's subscription state. Unlike Clerk's svix signatures, RevenueCat
 * signs with a plain `Authorization: Bearer <secret>` header (dashboard ->
 * Integrations -> Webhooks).
 *
 * Event semantics:
 *   grant  (INITIAL_PURCHASE, RENEWAL, UNCANCELLATION, PRODUCT_CHANGE,
 *           NON_RENEWING_PURCHASE, SUBSCRIPTION_EXTENDED)
 *          -> set pro_until = expiration_at_ms
 *   revoke (EXPIRATION) -> clear pro_until
 *   everything else (CANCELLATION, BILLING_ISSUE, SUBSCRIPTION_PAUSED, ...)
 *          -> no-op: the entitlement stays valid until its expiry, so we must
 *             NOT clear pro_until on those.
 *
 * Both the legacy (v1) and Webhooks 2.0 (v2) payload shapes are handled: v1
 * nests everything under `event`, v2 keeps `type` at the top level with the
 * details under `event` — reading `body.event ?? body` covers both.
 */

const GRANT_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'NON_RENEWING_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED',
]);

interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  entitlement_ids?: string[];
  expiration_at_ms?: number;
  event_timestamp_ms?: number;
  product_id?: string;
  store?: string;
  environment?: string;
}

const configured = Boolean(env.REVENUECAT_WEBHOOK_SECRET);

/** Constant-time comparison — never a plain `===` on a shared secret. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function revenueCatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/revenuecat', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!configured) {
      request.log.warn('REVENUECAT_WEBHOOK_SECRET not configured — rejecting webhook');
      return sendError(
        request,
        reply,
        500,
        'INTERNAL_ERROR',
        'Webhook verification is not configured.',
      );
    }

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token || !safeEqual(token, env.REVENUECAT_WEBHOOK_SECRET!)) {
      return sendError(request, reply, 401, 'UNAUTHENTICATED', 'Invalid webhook signature.');
    }

    // v1 nests everything under `event`; Webhooks 2.0 keeps `type` at the top
    // with the details under `event`. Merge so `event` always carries the
    // fields we need and `type` falls back to the top level.
    const raw = request.body as { type?: string; event?: RevenueCatEvent } | undefined;
    const event = (raw?.event ?? raw) as RevenueCatEvent | undefined;
    const type = event?.type ?? raw?.type;
    const appUserId = event?.app_user_id;
    const expirationMs = event?.expiration_at_ms;
    const eventId = event?.id;
    const rawBody = request.rawBody;

    if (!eventId || !type || !rawBody) {
      return sendError(request, reply, 400, 'VALIDATION_ERROR', 'Invalid RevenueCat event.');
    }

    const claimed = await claimWebhookEvent({
      provider: 'revenuecat',
      providerEventId: eventId,
      eventType: type,
      payloadHash: payloadHash(rawBody),
    });
    if (!claimed) return reply.code(204).send();

    try {
      if (!appUserId || (event.entitlement_ids && !event.entitlement_ids.includes('pro'))) {
        await markWebhookProcessed('revenuecat', eventId);
        return reply.code(204).send();
      }

      let isActive: boolean;
      let proUntil: Date | null;
      if (GRANT_EVENTS.has(type)) {
        isActive = true;
        proUntil = expirationMs ? new Date(expirationMs) : null;
      } else if (type === 'EXPIRATION') {
        isActive = false;
        proUntil = null;
      } else {
        await markWebhookProcessed('revenuecat', eventId);
        return reply.code(204).send();
      }

      const candidates = [...new Set([
        appUserId,
        event.original_app_user_id,
        ...(event.aliases ?? []),
      ].filter((value): value is string => Boolean(value)))];
      const matches = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, candidates));
      const userId = matches.find((item) => item.id === appUserId)?.id ?? matches[0]?.id;

      if (!userId) {
        request.log.warn({ type }, 'RevenueCat event for unknown user — ignored');
        await markWebhookProcessed('revenuecat', eventId);
        return reply.code(204).send();
      }

      const sourceEventAt = new Date(event.event_timestamp_ms ?? Date.now());
      const existing = await db.query.entitlements.findFirst({
        where: and(
          eq(entitlements.userId, userId),
          eq(entitlements.entitlementId, 'pro'),
        ),
      });
      if (existing && existing.sourceEventAt > sourceEventAt) {
        await markWebhookProcessed('revenuecat', eventId);
        return reply.code(204).send();
      }

      await db.transaction(async (tx) => {
        await tx
          .insert(entitlements)
          .values({
            userId,
            entitlementId: 'pro',
            isActive,
            productId: event.product_id,
            store: event.store,
            environment: event.environment,
            expiresAt: proUntil,
            originalAppUserId: event.original_app_user_id,
            sourceEventAt,
          })
          .onConflictDoUpdate({
            target: [entitlements.userId, entitlements.entitlementId],
            set: {
              isActive,
              productId: event.product_id,
              store: event.store,
              environment: event.environment,
              expiresAt: proUntil,
              originalAppUserId: event.original_app_user_id,
              sourceEventAt,
              updatedAt: new Date(),
            },
          });
        await tx
          .update(users)
          .set({ proUntil, updatedAt: new Date() })
          .where(eq(users.id, userId));
      });

      await markWebhookProcessed('revenuecat', eventId);
      return reply.code(204).send();
    } catch (error) {
      await markWebhookFailed('revenuecat', eventId, error);
      throw error;
    }
  });
}
