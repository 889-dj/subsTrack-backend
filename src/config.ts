// Load .env for local dev (no-op in production/containers where real env vars
// are set — dotenv never overrides an existing variable).
import 'dotenv/config';
import { z } from 'zod';

/**
 * Central env parsing — fail fast at boot on a malformed environment instead
 * of crashing mid-request. All values are read from process.env once.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  // Optional so the skeleton boots for local dev before Clerk is set up;
  // authenticated routes refuse requests with a clear error until it is.
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  DATABASE_URL: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/substrack'),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  // Comma-separated allowed origins for the Expo web build. Empty = allow all
  // (dev); set to your domain(s) in production.
  CORS_ORIGINS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
