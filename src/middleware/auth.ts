import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '@clerk/backend';
import { env } from '../config.js';
import { sendError } from '../errors.js';
import { ensureLocalUser } from '../services/clerk.js';

/**
 * Clerk session verification. The mobile app sends the Clerk session token as
 * `Authorization: Bearer <token>`; we verify the JWT's signature and expiry
 * (networkless when CLERK_JWT_KEY / the PEM is set, otherwise via Clerk's
 * cached JWKS) and attach the Clerk user id (`sub`) to the request.
 *
 * Hardening note: verifyToken checks signature + expiry, not session
 * revocation. To force sign-out to take effect instantly, upgrade to
 * `clerk.authenticateRequest(new Request(...))` or check
 * `clerk.sessions.getSession(...)` — see docs/backend-prd.md §Auth.
 *
 * Guards: missing secret -> 500 "auth not configured"; missing/invalid token
 * -> 401. Never trust a user id that didn't come from a verified token.
 */

const configured = Boolean(env.CLERK_SECRET_KEY);

declare module 'fastify' {
  interface FastifyRequest {
    /** Clerk user id (`sub` claim). Only set on routes behind `requireAuth`. */
    userId?: string;
    /**
     * Raw JSON body bytes. Populated because src/app.ts registers the JSON
     * content type with parseAs: 'buffer' (needed for webhook signatures);
     * Fastify v5 doesn't type it, so we declare it here.
     */
    rawBody?: Buffer;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    await sendError(request, reply, 401, 'UNAUTHENTICATED', 'Missing bearer token.');
    return;
  }

  if (!configured) {
    request.log.warn('Rejecting authenticated request: CLERK_SECRET_KEY is not configured');
    await sendError(
      request,
      reply,
      500,
      'INTERNAL_ERROR',
      'Authentication is not configured on this server.',
    );
    return;
  }

  let sub: string;
  try {
    const verified = await verifyToken(header.slice('Bearer '.length), {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY || undefined,
      audience: env.CLERK_AUDIENCE || undefined,
      authorizedParties: env.CLERK_AUTHORIZED_PARTIES
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
    if (!verified.sub) {
      await sendError(request, reply, 401, 'UNAUTHENTICATED', 'Invalid token.');
      return;
    }
    sub = verified.sub;
  } catch (err) {
    request.log.warn(
      { errorName: err instanceof Error ? err.name : 'Unknown' },
      'Token verification failed',
    );
    await sendError(request, reply, 401, 'UNAUTHENTICATED', 'Invalid or expired token.');
    return;
  }

  try {
    const state = await ensureLocalUser(sub);
    if (state === 'deleted') {
      await sendError(request, reply, 403, 'FORBIDDEN', 'This account has been deleted.');
      return;
    }
    request.userId = sub;
  } catch (err) {
    request.log.error(
      { errorName: err instanceof Error ? err.name : 'Unknown' },
      'Authenticated user reconciliation failed',
    );
    await sendError(request, reply, 500, 'INTERNAL_ERROR', 'Could not load the authenticated account.');
  }
}

/** Convenience getter so handlers read a non-nullable user id. */
export function currentUser(request: FastifyRequest): string {
  if (!request.userId) {
    throw new Error('requireAuth must be applied before currentUser is read');
  }
  return request.userId;
}
