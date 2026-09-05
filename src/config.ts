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
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Optional so the skeleton boots for local dev before Clerk is set up;
  // authenticated routes refuse requests with a clear error until it is.
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  CLERK_AUDIENCE: z.string().optional(),
  DATABASE_URL: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/substrack'),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  // Optional logo.dev publishable token for subscription logos. Unset falls
  // back to Google's key-free favicon service (lower resolution).
  LOGO_DEV_TOKEN: z.string().optional(),
  // Optional OpenRouter key for AI-generated spend insights. Unset means the
  // /v1/insights route degrades to an empty result instead of erroring.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  // Optional Cloudinary URL for profile photo uploads, e.g.
  // cloudinary://<api_key>:<api_secret>@<cloud_name> (free tier). Unset means
  // POST /v1/me/avatar responds 503 instead of accepting an upload it can't store.
  CLOUDINARY_URL: z.string().optional(),
  // Comma-separated allowed origins for the Expo web build. Empty = allow all
  // (dev); set to your domain(s) in production.
  CORS_ORIGINS: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  DELETION_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // How often to scan for renewals due within 24h and send a push reminder.
  // Only needs to be shorter than the 24h window, not exact.
  RENEWAL_REMINDER_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 60_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  const required = [
    'CLERK_SECRET_KEY',
    // CLERK_WEBHOOK_SECRET and REVENUECAT_WEBHOOK_SECRET are intentionally
    // not required: ensureLocalUser() lazily reconciles the local user row
    // on first authenticated request regardless of whether the Clerk
    // webhook has fired yet, and nothing reads the RevenueCat entitlement
    // projection its webhook feeds (isPro comes from the SDK on-device).
    // Add either back once something actually depends on it.
    'REVENUECAT_SECRET_API_KEY',
    'CORS_ORIGINS',
  ] as const;
  const missing = required.filter((key) => !parsed.data[key]?.trim());
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Missing required production configuration: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const env = parsed.data;
