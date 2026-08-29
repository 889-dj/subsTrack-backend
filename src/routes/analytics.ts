import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildOverview, buildSpendTrend } from '../analytics.js';
import { db } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';

const trendQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
  currency: z.string().trim().length(3).toUpperCase().optional(),
}).strict();

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/analytics/spend-trend', { preHandler: requireAuth }, async (request) => {
    const query = trendQuery.parse(request.query);
    const userId = currentUser(request);
    const subs = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
        ),
      );
    const series = buildSpendTrend(subs, query.months).filter(
      (item) => !query.currency || item.currency === query.currency,
    );
    return { series };
  });

  app.get('/v1/analytics/overview', { preHandler: requireAuth }, async (request) => {
    const userId = currentUser(request);
    const subs = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'active'),
        ),
      );
    const result = buildOverview(subs);
    request.log.info({ userId, subCount: subs.length, result }, 'GET /v1/analytics/overview response');
    return result;
  });
}
