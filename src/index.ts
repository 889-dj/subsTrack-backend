import { buildApp } from './app.js';
import { env } from './config.js';
import { connection } from './db/client.js';

async function main(): Promise<void> {
  const app = buildApp();

  // Fail fast if the database is unreachable — better than serving 5xx to
  // every request. (Run `npm run db:migrate` once before first boot.)
  await connection`select 1`;
  app.log.info('Database connection verified');

  // 0.0.0.0, not localhost: Coolify/Caddy proxy 443 to this port from another
  // container/network namespace.
  await app.listen({ host: '0.0.0.0', port: env.PORT });

  // Graceful shutdown — stop accepting connections, let in-flight requests
  // finish, then close the pool so the orchestrator sees a clean exit.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await connection.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
