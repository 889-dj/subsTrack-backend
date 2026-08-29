import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildOverview } from '../analytics.js';
import { db } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getInsights } from '../insights.js';

const insightsQuery = z.object({
  refresh: z.coerce.boolean().default(false),
}).strict();

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // AI-generated observations over the same numbers /v1/analytics/overview
  // already computes. Degrades to { insights: [], generatedAt: null } when
  // OPENROUTER_API_KEY is unset or the model call fails — never a 5xx.
  app.get('/v1/insights', { preHandler: requireAuth }, async (request) => {
    const { refresh } = insightsQuery.parse(request.query);
    const userId = currentUser(request);
    const subs = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active')));
    const overview = buildOverview(subs);
    const result = await getInsights(userId, overview, refresh);
    request.log.info({ userId, result }, 'GET /v1/insights response');
    return result;
  });
}
