import type { FastifyInstance } from 'fastify';
import { connection } from '../db/client.js';
import { API_VERSION, CATEGORIES, CURRENCIES } from '../constants.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — process is up.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness — dependencies reachable. Used by the orchestrator (Coolify) to
  // decide whether to route traffic / restart the container.
  app.get('/readyz', async (_request, reply) => {
    try {
      await connection`select 1`;
      return { status: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'Readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // Lets the app refresh its currency/category lists without an app-store
  // release (the client currently hardcodes them in src/types.ts).
  app.get('/v1/meta', async () => ({
    version: API_VERSION,
    currencies: CURRENCIES,
    categories: CATEGORIES,
  }));
}
