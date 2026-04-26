import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { env } from '../env.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';

const log = logger.child({ area: 'db' });

/**
 * Lazy Postgres client + Drizzle instance. Exposed at module scope so
 * call sites import `db` directly — Hono's request lifecycle is short
 * enough that a single long-lived connection pool is the right shape.
 *
 * `max: 10` matches the default for `postgres` (the library); tune via
 * `DATABASE_POOL_MAX` if we ever outgrow single-digit concurrency per
 * machine.
 */
// A2-724: per-session statement_timeout. Postgres-js's `connection`
// option becomes the startup-parameter set sent on each connect, so
// every connection out of this pool has the timeout applied without
// us needing a per-query SET LOCAL. Value of 0 turns the timeout off
// (matches Postgres's own convention).
const startupParameters: Record<string, string> = {};
if (env.DATABASE_STATEMENT_TIMEOUT_MS > 0) {
  startupParameters['statement_timeout'] = String(env.DATABASE_STATEMENT_TIMEOUT_MS);
}

const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  // `idle_timeout` closes pool members after N seconds of inactivity.
  // Prevents the pool from hoarding connections at quiet times and
  // interacting badly with Fly Postgres idle disconnects.
  idle_timeout: 20,
  connect_timeout: 10,
  // A2-724: see `startupParameters` above.
  connection: startupParameters,
  // We use `bigint` mode on our bigint columns in schema.ts; keep the
  // driver in sync so `balance_minor` round-trips as a BigInt
  // end-to-end instead of silently truncating to Number.
  types: {
    bigint: postgres.BigInt,
  },
});

export const db = drizzle(client, { schema });
export type DB = typeof db;

/**
 * Run pending migrations and resolve. Called at backend startup so a
 * fresh deploy applies any schema changes before it starts serving.
 * Safe to call repeatedly — the migrator no-ops on an up-to-date DB.
 */
export async function runMigrations(): Promise<void> {
  log.info('Applying database migrations');
  await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
  log.info('Migrations up to date');
}

/**
 * Best-effort graceful shutdown hook. Not wired into the process by
 * default — call from a SIGTERM handler if the deploy target needs
 * the pool flushed.
 */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
