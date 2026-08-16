import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { chargeTimestamps } from '../billing.js';

/**
 * GET /v1/analytics/spend-trend — real monthly spend history, the replacement
 * for the client's synthesized `synthesizeSpendTrend()`. Instead of a
 * fabricated rising curve it sums the actual charges due in each of the last
 * 12 months (same cadence math as the payments backfill: charge timestamps
 * step back from each subscription's next renewal by its billing interval,
 * bounded by creation date and "not in the future").
 *
 * Response: { months: ['2025-09', ...], totals: number[] } — oldest month
 * first, `totals[i]` is the spend for `months[i]` in the subscription's own
 * currency (no cross-currency conversion, per PRD §12.5).
 */

const MONTHS = 12;

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/analytics/spend-trend', { preHandler: requireAuth }, async (request) => {
    const userId = currentUser(request);
    const subs = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));

    const now = new Date();
    const months: string[] = [];
    for (let i = MONTHS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const totals = new Array<number>(MONTHS).fill(0);
    for (const sub of subs) {
      for (const t of chargeTimestamps(sub)) {
        const d = new Date(t);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const idx = months.indexOf(key);
        if (idx >= 0) totals[idx] = (totals[idx] ?? 0) + sub.cost;
      }
    }

    return { months, totals };
  });
}
