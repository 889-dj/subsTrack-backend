import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { deletionJobs, entitlements, subscriptions, users } from '../db/schema.js';
import { clerk } from './clerk.js';

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

async function deleteRevenueCatCustomer(userId: string): Promise<void> {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    throw new Error('RevenueCat secret API key is not configured.');
  }
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`RevenueCat deletion failed with status ${response.status}.`);
  }
}

export async function scheduleAccountDeletion(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await tx.delete(entitlements).where(eq(entitlements.userId, userId));
    await tx
      .insert(deletionJobs)
      .values({ userId })
      .onConflictDoUpdate({
        target: deletionJobs.userId,
        set: {
          status: 'pending',
          nextAttemptAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });
  });
}

export async function processDeletionJob(userId: string): Promise<void> {
  try {
    await deleteRevenueCatCustomer(userId);
    if (!clerk) throw new Error('Clerk management client is not configured.');
    try {
      await clerk.users.deleteUser(userId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, userId));
      await tx.delete(deletionJobs).where(eq(deletionJobs.userId, userId));
    });
  } catch (error) {
    const current = await db.query.deletionJobs.findFirst({
      where: eq(deletionJobs.userId, userId),
    });
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
    await db
      .update(deletionJobs)
      .set({
        status: 'failed',
        attempts: sql`${deletionJobs.attempts} + 1`,
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown deletion error',
        nextAttemptAt: new Date(Date.now() + delay),
        updatedAt: new Date(),
      })
      .where(eq(deletionJobs.userId, userId));
    throw error;
  }
}

export async function processPendingDeletionJobs(log: FastifyBaseLogger): Promise<void> {
  const jobs = await db
    .select({ userId: deletionJobs.userId })
    .from(deletionJobs)
    .where(
      and(
        or(eq(deletionJobs.status, 'pending'), eq(deletionJobs.status, 'failed')),
        lte(deletionJobs.nextAttemptAt, new Date()),
      ),
    )
    .limit(20);

  for (const job of jobs) {
    try {
      await processDeletionJob(job.userId);
      log.info('Account deletion job completed');
    } catch (error) {
      log.error(
        { errorName: error instanceof Error ? error.name : 'Unknown' },
        'Account deletion job failed and will retry',
      );
    }
  }
}
