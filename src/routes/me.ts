import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUser(request);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user || user.deletedAt) {
      // Session is valid but we don't know the user (missed webhook, or
      // deleted). Treat as not found rather than silently creating a row.
      return reply.code(404).send({ message: 'User not found.' });
    }

    return {
      id: user.id,
      email: user.email,
      isPro: user.proUntil !== null && user.proUntil.getTime() > Date.now(),
    };
  });
}
