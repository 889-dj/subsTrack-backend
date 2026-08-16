import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { payments, subscriptions, type SubscriptionRow } from '../db/schema.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { backfillPayments } from '../billing.js';
import { BILLING_CYCLES, CURRENCIES } from '../constants.js';

/**
 * CRUD for the only core resource. Shapes match the mobile client's
 * Subscription / SubscriptionInput in src/types.ts byte-for-byte:
 *   cost: number · billingCycle: 'monthly'|'yearly' · nextRenewalDate: ISO date
 *   category/source/plan/note: optional free-form strings
 * Ownership is enforced in SQL (WHERE user_id = ...) — other users' rows are
 * indistinguishable from missing ones (404, not 403).
 */

const subscriptionInput = z.object({
  name: z.string().trim().min(1, 'Give it a name.').max(100),
  cost: z.number().positive('Enter what it charges.').max(1_000_000_000),
  currency: z.enum(CURRENCIES, { message: 'Unsupported currency.' }),
  billingCycle: z.enum(BILLING_CYCLES),
  nextRenewalDate: z.string().datetime({ offset: true }),
  category: z.string().trim().max(50).optional(),
  source: z.string().trim().max(50).optional(),
  plan: z.string().trim().max(50).optional(),
  note: z.string().trim().max(500).optional(),
});

const subscriptionUpdate = subscriptionInput.partial();

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  const scoped = (userId: string) => eq(subscriptions.userId, userId);

  // List — no pagination: small per-user dataset and every tab needs it whole.
  app.get('/v1/subscriptions', { preHandler: requireAuth }, async (request) => {
    const rows = await db
      .select()
      .from(subscriptions)
      .where(scoped(currentUser(request)))
      .orderBy(desc(subscriptions.createdAt));
    return rows.map(toApi);
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
      // Materialize past charges so the payments endpoint has real history.
      await backfillPayments(row!);
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

      if (!row[0]) return reply.code(404).send({ message: 'Subscription not found.' });
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

      if (!row) return reply.code(404).send({ message: 'Subscription not found.' });
      // Re-derive history after an edit — new charges may be in the past now,
      // and existing rows are kept (idempotent via the unique constraint).
      await backfillPayments(row);
      return toApi(row);
    },
  );

  // Payment history for the detail screen — the real replacement for the
  // client's synthesizePaymentHistory(). Ownership is enforced by looking the
  // subscription up scoped to the user first.
  app.get(
    '/v1/subscriptions/:id/payments',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = currentUser(request);
      const sub = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.id, id), scoped(userId)))
        .limit(1);
      if (!sub[0]) return reply.code(404).send({ message: 'Subscription not found.' });

      const rows = await db
        .select()
        .from(payments)
        .where(eq(payments.subscriptionId, id))
        .orderBy(desc(payments.chargedAt))
        .limit(50);
      return rows.map((p) => ({
        id: p.id,
        date: p.chargedAt.toISOString(),
        amount: p.amount,
        currency: p.currency,
      }));
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
      if (!row) return reply.code(404).send({ message: 'Subscription not found.' });
      return toApi(row);
    },
  );

  app.post(
    '/v1/subscriptions/:id/resume',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [row] = await db
        .update(subscriptions)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(subscriptions.id, id), scoped(currentUser(request))))
        .returning();
      if (!row) return reply.code(404).send({ message: 'Subscription not found.' });
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

      if (deleted.length === 0) return reply.code(404).send({ message: 'Subscription not found.' });
      return reply.code(204).send();
    },
  );
}
