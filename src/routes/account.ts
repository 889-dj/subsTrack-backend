import type { FastifyInstance } from 'fastify';
import { createClerkClient } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { env } from '../config.js';

/**
 * Account lifecycle. The only deletion endpoint — required by App Store
 * review ("delete my account" must actually delete). Flow:
 *
 *   1. Delete the `users` row — subscriptions go with it via the FK's
 *      `onDelete: 'cascade'`, so a single statement removes all user data.
 *   2. Fire Clerk's `users.deleteUser` so the auth account is gone too.
 *      Best-effort: a missing/invalid CLERK_SECRET_KEY only logs a warning —
 *      the local data is still deleted and the user gets their 204.
 *
 * Idempotent per the PRD: a second call 404s (row already gone).
 */

// Lazy singleton; constructed once at boot like the svix Webhook guard in
// webhooks.ts. Null when CLERK_SECRET_KEY isn't set — the route still works,
// it just can't revoke the Clerk account.
const clerk = env.CLERK_SECRET_KEY ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY }) : null;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.delete('/v1/account', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUser(request);

    const deleted = await db
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (deleted.length === 0) {
      return reply.code(404).send({ message: 'User not found.' });
    }

    if (!clerk) {
      request.log.warn('CLERK_SECRET_KEY not configured — Clerk user not deleted');
    } else {
      try {
        await clerk.users.deleteUser(userId);
      } catch (err) {
        // Local data is already gone; surface the partial failure loudly so
        // the sync gap doesn't go unnoticed.
        request.log.error({ err, userId }, 'Failed to delete Clerk user after local deletion');
      }
    }

    return reply.code(204).send();
  });
}
