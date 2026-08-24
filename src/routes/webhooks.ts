import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Webhook } from 'svix';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../config.js';
import { sendError } from '../errors.js';
import {
  claimWebhookEvent,
  markWebhookFailed,
  markWebhookProcessed,
  payloadHash,
} from '../services/webhook-events.js';

/**
 * Clerk webhook — keeps the `users` table in sync with Clerk's identity store.
 * Signatures are verified with svix; an unsigned or mis-signed request is
 * rejected before any handler logic runs.
 *
 * Events handled: user.created / user.updated / user.deleted.
 */

interface ClerkUserEvent {
  type: 'user.created' | 'user.updated' | 'user.deleted';
  data: {
    id: string;
    deleted?: boolean;
    email_addresses?: { email_address: string }[];
  };
}

// svix throws at construction if the signing secret isn't a valid base64
// `whsec_...` string. Guard so a missing/bad secret degrades to "webhook not
// configured" (500 on the endpoint) instead of crashing the server at boot.
let webhook: Webhook | null = null;
if (env.CLERK_WEBHOOK_SECRET) {
  try {
    webhook = new Webhook(env.CLERK_WEBHOOK_SECRET);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('CLERK_WEBHOOK_SECRET is invalid — webhook endpoint disabled', err);
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/clerk', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!webhook) {
      request.log.warn('CLERK_WEBHOOK_SECRET not configured — rejecting webhook');
      return sendError(
        request,
        reply,
        500,
        'INTERNAL_ERROR',
        'Webhook verification is not configured.',
      );
    }

    const rawBody = request.rawBody;
    const eventId = request.headers['svix-id'] as string | undefined;
    if (!rawBody || !eventId) {
      return sendError(request, reply, 400, 'VALIDATION_ERROR', 'Missing signed webhook body.');
    }

    let event: ClerkUserEvent;
    try {
      event = webhook.verify(
        rawBody.toString('utf8'),
        {
          'svix-id': (request.headers['svix-id'] as string) ?? '',
          'svix-timestamp': (request.headers['svix-timestamp'] as string) ?? '',
          'svix-signature': (request.headers['svix-signature'] as string) ?? '',
        },
      ) as ClerkUserEvent;
    } catch {
      return sendError(request, reply, 401, 'UNAUTHENTICATED', 'Invalid webhook signature.');
    }

    const { type, data } = event;
    const claimed = await claimWebhookEvent({
      provider: 'clerk',
      providerEventId: eventId,
      eventType: type,
      payloadHash: payloadHash(rawBody),
    });
    if (!claimed) return reply.code(204).send();

    try {
      if (type === 'user.deleted' || data.deleted) {
        await db
          .update(users)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, data.id));
        await markWebhookProcessed('clerk', eventId);
        return reply.code(204).send();
      }

      const email = data.email_addresses?.[0]?.email_address;
      if (!email) {
        request.log.warn({ userId: data.id }, 'Clerk event without an email — ignored');
        await markWebhookProcessed('clerk', eventId);
        return reply.code(204).send();
      }

      await db
        .insert(users)
        .values({ id: data.id, email })
        .onConflictDoUpdate({
          target: users.id,
          set: { email, updatedAt: new Date() },
        });

      await markWebhookProcessed('clerk', eventId);
      return reply.code(204).send();
    } catch (error) {
      await markWebhookFailed('clerk', eventId, error);
      throw error;
    }
  });
}
