import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { env } from '../config.js';

/**
 * Single shared connection pool. Drizzle infers the schema so every query is
 * type-checked against the tables in schema.ts.
 */
export const connection = postgres(env.DATABASE_URL, {
  max: 10,
  // postgres-js can't use prepared statements through a connection pooler
  // (Neon's PgBouncer in transaction mode) — disable for compatibility.
  prepare: false,
});

export const db = drizzle(connection, { schema });

export type Db = typeof db;
