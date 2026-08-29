import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config.js';
import { accountRoutes } from './routes/account.js';
import { analyticsRoutes } from './routes/analytics.js';
import { healthRoutes } from './routes/health.js';
import { insightsRoutes } from './routes/insights.js';
import { meRoutes } from './routes/me.js';
import { revenueCatRoutes } from './routes/revenuecat.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { webhookRoutes } from './routes/webhooks.js';
import { AVATAR_MAX_BYTES } from './services/avatar.js';

/**
 * Application assembly. Kept separate from the bootstrap (src/index.ts) so
 * tests can build the app without binding a port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      // Pretty logs in dev, structured JSON in prod (Coolify collects stdout).
      ...(env.NODE_ENV === 'development' && env.LOG_PRETTY && {
        transport: { target: 'pino-pretty' },
      }),
    },
    // Behind Coolify/Caddy — needed for correct client IPs in logs/rate limiting.
    trustProxy: true,
    // 1 MB is plenty: the largest payload is a subscription (a few hundred bytes).
    bodyLimit: 1_048_576,
  });

  // Required for the Expo web build (browser fetch enforces CORS). Native apps
  // ignore it. Restrict with CORS_ORIGINS in production.
  app.register(cors, {
    origin: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
      : env.NODE_ENV !== 'production',
  });

  app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  });

  // Only route that accepts multipart/form-data is POST /v1/me/avatar. The
  // real size cap is here (files: 1, one field); the route's own bodyLimit
  // override just needs to be large enough to not reject the request first.
  app.register(multipart, {
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0 },
  });

  // Parse JSON as a Buffer so webhook signature verification (svix) can read
  // the exact bytes, while handlers still receive a parsed object via body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    try {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = rawBody;
      done(null, rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Uniform error responses. The mobile client reads `e.response.data.message`,
  // so validation failures must surface as { message } with a 4xx status.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ZodError) {
      const fields = Object.fromEntries(
        err.issues
          .filter((issue) => issue.path.length > 0)
          .map((issue) => [issue.path.join('.'), issue.message]),
      );
      return reply.code(400).send({
        message: err.errors[0]?.message ?? 'Invalid input.',
        code: 'VALIDATION_ERROR',
        requestId: request.id,
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'Unhandled error');
    const code = status === 401
      ? 'UNAUTHENTICATED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'NOT_FOUND'
          : status === 409
            ? 'CONFLICT'
            : status === 429
              ? 'RATE_LIMITED'
              : status >= 500
                ? 'INTERNAL_ERROR'
                : 'VALIDATION_ERROR';
    return reply.code(status).send({
      message: status >= 500 ? 'An unexpected server error occurred.' : err.message,
      code,
      requestId: request.id,
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    if (request.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.register(healthRoutes);
  app.register(meRoutes);
  app.register(subscriptionRoutes);
  app.register(webhookRoutes);
  app.register(revenueCatRoutes);
  app.register(accountRoutes);
  app.register(analyticsRoutes);
  app.register(insightsRoutes);

  return app;
}
