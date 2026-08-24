import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entitlements, users } from '../db/schema.js';
import { sendError } from '../errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUser(request);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user || user.deletedAt) {
      return sendError(request, reply, 404, 'NOT_FOUND', 'User not found.');
    }

    const entitlement = await db.query.entitlements.findFirst({
      where: and(
        eq(entitlements.userId, userId),
        eq(entitlements.entitlementId, 'pro'),
      ),
    });
    const entitlementActive = Boolean(
      entitlement?.isActive &&
      (!entitlement.expiresAt || entitlement.expiresAt.getTime() > Date.now()),
    );
    const legacyActive = Boolean(user.proUntil && user.proUntil.getTime() > Date.now());

    return {
      id: user.id,
      email: user.email,
      isPro: entitlementActive || legacyActive,
      proUntil: entitlement?.expiresAt?.toISOString() ?? user.proUntil?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  });
}
