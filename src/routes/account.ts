import type { FastifyInstance } from 'fastify';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  processDeletionJob,
  scheduleAccountDeletion,
} from '../services/account-deletion.js';

/**
 * Account lifecycle. The only deletion endpoint — required by App Store
 * review ("delete my account" must actually delete). Flow:
 *
 * Local access is revoked transactionally and a durable outbox job removes
 * the customer from RevenueCat and Clerk. External failures are retried.
 *
 * Idempotent per the PRD: a second call 404s (row already gone).
 */

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.delete('/v1/account', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUser(request);
    await scheduleAccountDeletion(userId);
    try {
      await processDeletionJob(userId);
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : 'Unknown' },
        'Account deletion scheduled for retry',
      );
    }

    return reply.code(204).send();
  });
}
