import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../config.js';

/**
 * RevenueCat webhook — keeps `users.pro_until` (the server-side copy of the
 * Pro entitlement, surfaced via `isPro` on GET /v1/me) in sync with
 * RevenueCat's subscription state. Unlike Clerk's svix signatures, RevenueCat
 * signs with a plain `Authorization: Bearer <secret>` header (dashboard ->
 * Integrations -> Webhooks).
 *
 * Event semantics:
 *   grant  (INITIAL_PURCHASE, RENEWAL, UNCANCELLATION, PRODUCT_CHANGE,
 *           NON_RENEWING_PURCHASE, TRANSFER, SUBSCRIPTION_EXTENDED)
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
  'TRANSFER',
  'SUBSCRIPTION_EXTENDED',
]);

interface RevenueCatEvent {
  type?: string;
  app_user_id?: string;
  expiration_at_ms?: number;
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
      return reply.code(500).send({ message: 'Webhook verification is not configured.' });
    }

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token || !safeEqual(token, env.REVENUECAT_WEBHOOK_SECRET!)) {
      return reply.code(401).send({ message: 'Invalid webhook signature.' });
    }

    // v1 nests everything under `event`; Webhooks 2.0 keeps `type` at the top
    // with the details under `event`. Merge so `event` always carries the
    // fields we need and `type` falls back to the top level.
    const raw = request.body as { type?: string; event?: RevenueCatEvent } | undefined;
    const event = (raw?.event ?? raw) as RevenueCatEvent | undefined;
    const type = event?.type ?? raw?.type;
    const appUserId = event?.app_user_id;
    const expirationMs = event?.expiration_at_ms;

    // Ack unknown/no-owner payloads — RevenueCat retries on non-2xx, so a
    // 204 on noise (TEST events, unknown user) is correct: nothing to do.
    if (!appUserId) return reply.code(204).send();

    let proUntil: Date | null;
    if (GRANT_EVENTS.has(type ?? '')) {
      proUntil = expirationMs ? new Date(expirationMs) : null;
    } else if (type === 'EXPIRATION') {
      proUntil = null;
    } else {
      // CANCELLATION / BILLING_ISSUE / SUBSCRIPTION_PAUSED etc. — entitlement
      // is still active, so leave pro_until untouched.
      return reply.code(204).send();
    }

    const updated = await db
      .update(users)
      .set({ proUntil, updatedAt: new Date() })
      .where(eq(users.id, appUserId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      // app_user_id is the Clerk sub; no row means the Clerk webhook hasn't
      // created the user yet (or they deleted their account). Log, don't
      // create a row — we can't fabricate the email.
      request.log.warn(
        { userId: appUserId, type },
        'RevenueCat event for unknown user — ignored',
      );
    }

    return reply.code(204).send();
  });
}
