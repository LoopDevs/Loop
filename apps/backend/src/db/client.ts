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
// every direct-postgres connection out of this pool has the timeout
// applied without us needing a per-query SET LOCAL. Value of 0 turns
// the timeout off (matches Postgres's own convention).
//
// PgBouncer (transaction mode) rejects `statement_timeout` as a
// startup parameter — connections fail with "unsupported startup
// parameter". When DATABASE_URL points at a PgBouncer endpoint (Fly
// MPG's `pgbouncer.*.flympg.net`, Supabase pooler, etc.), skip the
// startup parameter; statement_timeout protection is omitted in that
// mode. Direct-postgres deployments and local dev keep the timeout
// as before. A per-query `SET LOCAL statement_timeout` rebuild is a
// future hardening; the empty timeout is acceptable at launch volume
// where every Loop query is short-lived by design.
/**
 * Heuristic: returns `true` when the connection URL points at a
 * PgBouncer / Supavisor / similar transaction-mode pooler that
 * rejects `statement_timeout` (and other restricted parameters) as
 * startup parameters. Exported for direct unit testing — the
 * detection ships behind the `connection: startupParameters` toggle
 * inside the module, so the test mirrors what the runtime code sees.
 *
 * Patterns covered:
 *   - Fly MPG pooler: `pgbouncer.<cluster>.flympg.net`
 *   - Supabase pooler: `<region>.pooler.supabase.com` (legacy/PgBouncer mode)
 *   - Generic pgbouncer hostnames the operator may use
 */
export function isPooledPostgresUrl(url: string): boolean {
  return /\bpgbouncer\b/i.test(url) || /\bpooler\b/i.test(url);
}

const isPgBouncerUrl = isPooledPostgresUrl(env.DATABASE_URL);
const startupParameters: Record<string, string> = {};
if (!isPgBouncerUrl && env.DATABASE_STATEMENT_TIMEOUT_MS > 0) {
  startupParameters['statement_timeout'] = String(env.DATABASE_STATEMENT_TIMEOUT_MS);
}

const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  // `idle_timeout` closes pool members after N seconds of inactivity.
  // Prevents the pool from hoarding connections at quiet times and
  // interacting badly with Fly Postgres idle disconnects.
  idle_timeout: 20,
  connect_timeout: 10,
  // A2-724: see `startupParameters` above. PgBouncer pooler hosts get
  // an empty connection object.
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
 * Run `fn` while holding a session-scoped Postgres advisory lock,
 * fleet-wide, on a DEDICATED reserved connection (hardening A8).
 *
 * Session advisory locks are a pool footgun — the unlock must land on
 * the SAME physical connection that took the lock, but a pooled query
 * can run on any member. `client.reserve()` pins one connection for
 * the lock's whole lifetime, so lock + `fn` + unlock are guaranteed
 * co-located, and the `finally` always releases (or the connection
 * close releases it if the process dies).
 *
 * Non-blocking (`pg_try_advisory_lock`): if another machine holds the
 * lock, `fn` is NOT run and the result is `{ ran: false }`. Callers
 * that single-flight a periodic tick treat that as "another instance
 * is the leader this tick" and skip.
 *
 * **Transaction-pooler guard.** Under a transaction-mode pooler
 * (PgBouncer/Supavisor), each statement can land on a different server
 * backend, so `pg_advisory_unlock` may miss the backend that took the
 * lock → the SESSION lock leaks and never releases. `reserve()` only
 * pins the client↔pooler socket, not the pooler↔server backend. So
 * when the URL is a pooler we do NOT take the lock — we run `fn`
 * un-serialised (degrading to the caller's pre-lock behaviour, which
 * for the payout worker is the accepted `SKIP LOCKED` per-machine
 * posture) rather than risk a leaked lock that stalls the queue.
 * Production uses the direct Postgres port (see deployment.md), so
 * this only trips on a misconfigured `DATABASE_URL`.
 *
 * **No lease is enforced here** — the CALLER is responsible for
 * bounding how long `fn` runs (e.g. the payout worker races its tick
 * body against a deadline), because a lock held across unbounded
 * network I/O by a hung-but-alive leader would otherwise stall the
 * whole fleet. This wrapper only guarantees the lock is released when
 * `fn` settles (resolve or throw) or the connection closes.
 */
export async function withAdvisoryLock<T>(
  lockKey: bigint,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (isPooledPostgresUrl(env.DATABASE_URL)) {
    // Cannot hold a reliable session lock through a transaction
    // pooler — run un-serialised rather than leak a lock. Logged so a
    // misconfiguration is visible.
    log.warn(
      'withAdvisoryLock called with a transaction-pooler DATABASE_URL — running fn WITHOUT the advisory lock (session locks are unsafe through a pooler). Use the direct Postgres port for fleet-wide single-flight.',
    );
    return { ran: true, value: await fn() };
  }
  const reserved = await client.reserve();
  try {
    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockKey}) AS locked
    `;
    if (row?.locked !== true) {
      return { ran: false };
    }
    try {
      const value = await fn();
      return { ran: true, value };
    } finally {
      await reserved`SELECT pg_advisory_unlock(${lockKey})`;
    }
  } finally {
    reserved.release();
  }
}

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
