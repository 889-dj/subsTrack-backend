import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { subscriptions, type SubscriptionRow } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { scheduledOccurrences } from '../billing.js';
import { BILLING_CYCLES, CURRENCIES } from '../constants.js';
import { sendError } from '../errors.js';

/**
 * CRUD for the only core resource. Shapes match the mobile client's
 * Subscription / SubscriptionInput in src/types.ts byte-for-byte:
 *   cost: number · billingCycle: 'monthly'|'yearly' · nextRenewalDate: ISO date
 *   category/source/plan/note: optional free-form strings
 * Ownership is enforced in SQL (WHERE user_id = ...) — other users' rows are
 * indistinguishable from missing ones (404, not 403).
 */

const subscriptionInput = z.object({
  name: z.string().trim().min(1, 'Give it a name.').max(120),
  cost: z
    .number()
    .positive('Enter what it charges.')
    .max(1_000_000_000)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
      'Use no more than two decimal places.',
    ),
  currency: z.enum(CURRENCIES, { message: 'Unsupported currency.' }),
  billingCycle: z.enum(BILLING_CYCLES),
  nextRenewalDate: z.string().datetime({ offset: true }),
  category: z.string().trim().max(100).optional(),
  source: z.string().trim().max(100).optional(),
  plan: z.string().trim().max(100).optional(),
  note: z.string().trim().max(1_000).optional(),
}).strict();

const subscriptionUpdate = subscriptionInput
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
const listQuery = z.object({
  status: z.enum(['active', 'paused', 'all']).default('all'),
}).strict();
const forecastQuery = z.object({
  months: z.coerce.number().int().min(1).max(60).default(12),
}).strict();
const resumeInput = z.object({
  nextRenewalDate: z.string().datetime({ offset: true }).optional(),
}).strict();

type SubscriptionInput = z.infer<typeof subscriptionInput>;

/** Serialize a row into the exact shape the mobile client expects. */
function toApi(row: SubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    cost: row.cost,
    currency: row.currency,
    billingCycle: row.billingCycle,
    nextRenewalDate: row.nextRenewalDate.toISOString(),
    category: row.category ?? undefined,
    source: row.source ?? undefined,
    plan: row.plan ?? undefined,
    note: row.note ?? undefined,
    // Legacy cancelled rows are non-renewing and surface as paused without
    // rewriting historical data during migration.
    status: row.status === 'cancelled' ? 'paused' : row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  const scoped = (userId: string) => eq(subscriptions.userId, userId);

  // List — no pagination yet: every tab needs the complete small collection.
  app.get('/v1/subscriptions', { preHandler: requireAuth }, async (request) => {
    const { status } = listQuery.parse(request.query);
    const conditions = [scoped(currentUser(request))];
    if (status === 'active') conditions.push(eq(subscriptions.status, 'active'));
    if (status === 'paused') {
      conditions.push(inArray(subscriptions.status, ['paused', 'cancelled']));
    }
    const rows = await db
      .select()
      .from(subscriptions)
      .where(and(...conditions))
      .orderBy(asc(subscriptions.nextRenewalDate), asc(subscriptions.name));
    return { items: rows.map(toApi), nextCursor: null };
  });

  app.post(
    '/v1/subscriptions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const input = subscriptionInput.parse(request.body);
      const userId = currentUser(request);
      const [row] = await db
        .insert(subscriptions)
        .values({ ...input, nextRenewalDate: new Date(input.nextRenewalDate), userId })
        .returning();
      return reply.code(201).send(toApi(row!));
    },
  );

  app.get(
    '/v1/subscriptions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.id, id), scoped(currentUser(request))))
        .limit(1);

      if (!row[0]) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }
      return toApi(row[0]);
    },
  );

  app.patch(
    '/v1/subscriptions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = subscriptionUpdate.parse(request.body);
      const userId = currentUser(request);
      // zod parses nextRenewalDate to a string; the timestamp column wants a
      // Date, so pull it out of the spread and convert it explicitly.
      const { nextRenewalDate, ...rest } = input;

      const [row] = await db
        .update(subscriptions)
        .set({
          ...rest,
          ...(nextRenewalDate ? { nextRenewalDate: new Date(nextRenewalDate) } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(subscriptions.id, id), scoped(userId)))
        .returning();

      if (!row) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }
      return toApi(row);
    },
  );

  // Forecast occurrences are inferred from cadence. They are deliberately not
  // called payments because the server has not observed a real transaction.
  app.get(
    '/v1/subscriptions/:id/forecast-occurrences',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { months } = forecastQuery.parse(request.query);
      const userId = currentUser(request);
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.id, id), scoped(userId)))
        .limit(1);
      if (!sub) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }

      const start = new Date();
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + months);
      const items = scheduledOccurrences(sub, start, end).map((date) => ({
        date: date.toISOString(),
        amount: sub.cost.toFixed(2),
        currency: sub.currency,
        estimated: true,
      }));
      return { items };
    },
  );

  // Pause/resume — the detail screen's "Pause" button (status column was
  // ready from day one). Both are idempotent: pausing a paused sub is a no-op
  // 200, resuming from any state goes back to 'active'.
  app.post(
    '/v1/subscriptions/:id/pause',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [row] = await db
        .update(subscriptions)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(subscriptions.id, id), scoped(currentUser(request))))
        .returning();
      if (!row) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }
      return toApi(row);
    },
  );

  app.post(
    '/v1/subscriptions/:id/resume',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = resumeInput.parse(request.body ?? {});
      const [row] = await db
        .update(subscriptions)
        .set({
          status: 'active',
          ...(input.nextRenewalDate
            ? { nextRenewalDate: new Date(input.nextRenewalDate) }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(subscriptions.id, id), scoped(currentUser(request))))
        .returning();
      if (!row) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }
      return toApi(row);
    },
  );

  app.delete(
    '/v1/subscriptions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await db
        .delete(subscriptions)
        .where(and(eq(subscriptions.id, id), scoped(currentUser(request))))
        .returning({ id: subscriptions.id });

      if (deleted.length === 0) {
        return sendError(request, reply, 404, 'NOT_FOUND', 'Subscription not found.');
      }
      return reply.code(204).send();
    },
  );
}
