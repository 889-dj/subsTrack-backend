import { createClerkClient } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export const clerk = env.CLERK_SECRET_KEY
  ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
  : null;

export type LocalUserState = 'active' | 'deleted';

/**
 * Clerk webhooks are eventually consistent. Reconcile a missing local row on
 * the first authenticated request so a delayed webhook cannot cause FK errors.
 */
export async function ensureLocalUser(userId: string): Promise<LocalUserState> {
  const existing = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (existing) return existing.deletedAt ? 'deleted' : 'active';
  if (!clerk) throw new Error('Clerk management client is not configured.');

  const remote = await clerk.users.getUser(userId);
  const primary = remote.emailAddresses.find(
    (email) => email.id === remote.primaryEmailAddressId,
  );
  const email = primary?.emailAddress ?? remote.emailAddresses[0]?.emailAddress;
  if (!email) throw new Error('Authenticated Clerk user has no email address.');

  const [row] = await db
    .insert(users)
    .values({ id: userId, email })
    .onConflictDoNothing()
    .returning({ deletedAt: users.deletedAt });

  if (row) return row.deletedAt ? 'deleted' : 'active';
  const raced = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!raced) throw new Error('Could not reconcile the authenticated user.');
  return raced.deletedAt ? 'deleted' : 'active';
}
