import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './config.js';
import { accountRoutes } from './routes/account.js';
import { analyticsRoutes } from './routes/analytics.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { revenueCatRoutes } from './routes/revenuecat.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { webhookRoutes } from './routes/webhooks.js';

/**
 * Application assembly. Kept separate from the bootstrap (src/index.ts) so
 * tests can build the app without binding a port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs in dev, structured JSON in prod (Coolify collects stdout).
      ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    },
    // Behind Coolify/Caddy — needed for correct client IPs in logs/rate limiting.
    trustProxy: true,
    // 1 MB is plenty: the largest payload is a subscription (a few hundred bytes).
    bodyLimit: 1_048_576,
  });

  // Required for the Expo web build (browser fetch enforces CORS). Native apps
  // ignore it. Restrict with CORS_ORIGINS in production.
  app.register(cors, {
    origin: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',') : true,
  });

  // Parse JSON as a Buffer so webhook signature verification (svix) can read
  // the exact bytes, while handlers still receive a parsed object via body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Uniform error responses. The mobile client reads `e.response.data.message`,
  // so validation failures must surface as { message } with a 4xx status.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        message: err.errors[0]?.message ?? 'Invalid input.',
      });
    }
    request.log.error({ err }, 'Unhandled error');
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ message: err.message });
  });

  app.register(healthRoutes);
  app.register(meRoutes);
  app.register(subscriptionRoutes);
  app.register(webhookRoutes);
  app.register(revenueCatRoutes);
  app.register(accountRoutes);
  app.register(analyticsRoutes);

  return app;
}
