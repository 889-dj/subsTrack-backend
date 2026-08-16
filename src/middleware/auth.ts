import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '@clerk/backend';
import { env } from '../config.js';

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
    await reply.code(401).send({ message: 'Missing bearer token.' });
    return;
  }

  if (!configured) {
    request.log.warn('Rejecting authenticated request: CLERK_SECRET_KEY is not configured');
    await reply.code(500).send({ message: 'Authentication is not configured on this server.' });
    return;
  }

  try {
    const { sub } = await verifyToken(header.slice('Bearer '.length), {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY || undefined,
    });
    if (!sub) {
      await reply.code(401).send({ message: 'Invalid token.' });
      return;
    }
    request.userId = sub;
  } catch (err) {
    request.log.warn({ err }, 'Token verification failed');
    await reply.code(401).send({ message: 'Invalid or expired token.' });
  }
}

/** Convenience getter so handlers read a non-nullable user id. */
export function currentUser(request: FastifyRequest): string {
  if (!request.userId) {
    throw new Error('requireAuth must be applied before currentUser is read');
  }
  return request.userId;
}
