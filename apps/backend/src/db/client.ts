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
 * FT-12: cap on how many advisory-lock holders may simultaneously hold
 * a reserved pool connection.
 *
 * Each `withAdvisoryLock` holder pins ONE connection for the lock's
 * whole lifetime (`client.reserve()`), AND its `fn` body draws at least
 * one MORE connection from the SAME pool (callers run `db` queries
 * inside `fn`). So without a bound, ~N concurrent holders (the ~15
 * fleet workers, plus per-request fence locks that scale with traffic)
 * can reserve EVERY pool member, leaving their `fn` bodies to queue
 * forever for a connection that never frees. postgres-js queues both
 * `reserve()` and ordinary queries with NO acquire timeout (an
 * exhausted pool just pushes onto its internal `queries` list and
 * awaits), and `statement_timeout` can't help a query that is waiting
 * for a connection rather than executing — so this is a hard, permanent
 * deadlock, not a slow query.
 *
 * Cap concurrent holders at floor(poolMax / 2): with at most poolMax/2
 * connections pinned by locks, at least ceil(poolMax/2) always remain
 * for the holders' `fn` bodies (and other traffic), so every body can
 * make progress and release — the pool can never deadlock on lock
 * reservations. The /2 encodes the "each locked worker needs >= 2 pool
 * connections" derivation directly. Excess holders wait in-process for
 * a permit WITHOUT pinning a connection, so waiting can't itself starve
 * the pool; under normal concurrency (< cap holders in flight) this is
 * a no-op. Exported for the DB-backed regression test.
 */
export const maxConcurrentLockHolders = Math.max(1, Math.floor(env.DATABASE_POOL_MAX / 2));
let availableLockHolderSlots = maxConcurrentLockHolders;
const lockHolderWaiters: Array<() => void> = [];

/** Take a holder permit, waiting in-process (no pinned connection) if at the cap. */
async function acquireLockHolderSlot(): Promise<void> {
  if (availableLockHolderSlots > 0) {
    availableLockHolderSlots -= 1;
    return;
  }
  // Permit is handed to us directly by `releaseLockHolderSlot` (FIFO).
  await new Promise<void>((resolve) => {
    lockHolderWaiters.push(resolve);
  });
}

/** Return a holder permit, handing it straight to the next FIFO waiter if any. */
function releaseLockHolderSlot(): void {
  const next = lockHolderWaiters.shift();
  if (next !== undefined) {
    // Direct handoff: the count stays the same, the waiter proceeds.
    next();
    return;
  }
  availableLockHolderSlots += 1;
}

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
 * **Transaction-pooler guard (BK-pooler).** Under a transaction-mode
 * pooler (PgBouncer/Supavisor), each statement can land on a different
 * server backend, so `pg_advisory_unlock` may miss the backend that
 * took the lock → the SESSION lock leaks and never releases (or two
 * machines both believe they hold it). `reserve()` only pins the
 * client↔pooler socket, not the pooler↔server backend. This wrapper
 * used to log a warn and then run `fn` UN-SERIALISED — a SILENT loss of
 * the fleet-wide fence that every caller relies on. It now FAILS CLOSED
 * instead: when the URL is a transaction pooler it THROWS rather than
 * run lock-dependent work without the lock. Callers that keep an
 * independent per-machine backstop (redeem's in-process fence, the
 * emission-sweep CAS) still have that backstop; what they no longer get
 * is a silent downgrade of the fleet-wide guarantee. Production uses the
 * direct Postgres port (see deployment.md), so this only trips on a
 * misconfigured `DATABASE_URL` — where failing loud is the safe outcome.
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
    // BK-pooler: fail CLOSED. A session-scoped advisory lock cannot be
    // held reliably through a transaction-mode pooler, so running `fn`
    // without it would silently drop the fleet-wide fence. Refuse
    // instead — a misconfigured pooler URL should crash loud, not run
    // lock-dependent work un-serialised.
    throw new Error(
      'withAdvisoryLock: DATABASE_URL points at a transaction-mode pooler ' +
        '(PgBouncer/Supavisor). Session-scoped advisory locks are unsafe through a ' +
        'transaction pooler — the unlock can miss the backend that holds the lock and the ' +
        'fleet-wide lock leaks. Refusing to run lock-dependent work (fail-closed) rather ' +
        'than silently running it un-serialised. Use the direct Postgres port for ' +
        'fleet-wide single-flight (see deployment.md).',
    );
  }
  // FT-12: take a holder permit before reserving a connection so
  // concurrent holders can never exhaust the pool and deadlock their
  // own `fn` bodies. Released in the outer `finally`, after the
  // reserved connection is released.
  await acquireLockHolderSlot();
  try {
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
  } finally {
    releaseLockHolderSlot();
  }
}

/**
 * BK-stmttimeout: build a DEDICATED single-connection client for running
 * migrations that DELIBERATELY omits the app `statement_timeout`.
 *
 * The app pool (`client`, above) sets `statement_timeout` as a startup
 * parameter so a runaway request query can't monopolise a pool slot.
 * But the migrator runs through a connection too, and a legitimate
 * migration (a large table rewrite, a `CREATE INDEX` over a big table, a
 * data backfill) can easily exceed the 30s app default. Applied to the
 * migrator, that timeout ABORTS the migration mid-flight — blocking the
 * deploy and potentially leaving the schema half-applied. So migrations
 * get their own connection with NO app statement_timeout (the server
 * default, typically 0 = unbounded); scoped to the app pool, the
 * timeout still protects every ordinary query. Exported so the DB-backed
 * test can assert the scoping.
 */
export function createMigrationClient(): ReturnType<typeof postgres> {
  return postgres(env.DATABASE_URL, {
    // One connection is enough — migrations run serially — and avoids
    // opening a second full-size pool at boot.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    // Intentionally NO `connection.statement_timeout`: a long, legitimate
    // migration must not be aborted by the app query timeout. Also keeps
    // the migrator pooler-safe (a pooler rejects the startup parameter).
    types: {
      bigint: postgres.BigInt,
    },
  });
}

/**
 * Run pending migrations and resolve. Called at backend startup so a
 * fresh deploy applies any schema changes before it starts serving.
 * Safe to call repeatedly — the migrator no-ops on an up-to-date DB.
 *
 * Runs on a dedicated connection WITHOUT the app `statement_timeout`
 * (BK-stmttimeout) so a long migration isn't aborted mid-flight; the
 * connection is always closed afterwards so boot doesn't leak it.
 */
export async function runMigrations(): Promise<void> {
  log.info('Applying database migrations');
  const migrationClient = createMigrationClient();
  try {
    await migrate(drizzle(migrationClient, { schema }), {
      migrationsFolder: new URL('./migrations', import.meta.url).pathname,
    });
    log.info('Migrations up to date');
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

/**
 * Best-effort graceful shutdown hook. Not wired into the process by
 * default — call from a SIGTERM handler if the deploy target needs
 * the pool flushed.
 */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
