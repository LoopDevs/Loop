/**
 * Real-postgres integration-test harness (A2-1705 closure infra).
 *
 * Connects to the `loop_test` database that `docker-compose up -d db`
 * provisions locally, runs the checked-in migrations against it, and
 * exposes a per-test `truncateAllTables()` so each test starts from a
 * clean schema state.
 *
 * Gated on `LOOP_E2E_DB=1` so unit-test runs (which use placeholder
 * DATABASE_URL + per-file mocks) don't accidentally pull in a real
 * connection. The companion `vitest.integration.config.ts` sets that
 * env var and an explicit DATABASE_URL pointing at `loop_test`.
 *
 * Why a separate helper rather than reusing `db/client.ts`: the
 * production client memo-caches a postgres-js pool at module load, so
 * importing it here means the test pool stays alive for the whole
 * process and `closeDb()` works on shutdown. The migration step uses
 * the same pool so DDL + DML go through one connection.
 *
 * Tables are truncated in dependency order with `RESTART IDENTITY` +
 * `CASCADE` so per-row sequences reset and FK chains tear cleanly. The
 * `migrations` schema row stays untouched — drizzle's migrator no-ops
 * when the journal is up-to-date, so we don't pay for re-applying.
 */
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from '../../db/client.js';

/**
 * Tables in the order they should be truncated. Listed dependency-
 * children-first; CASCADE handles any FK we miss but explicit order
 * keeps the truncation deterministic.
 */
const TABLES_TO_TRUNCATE = [
  'pending_payouts',
  'credit_transactions',
  'user_credits',
  'orders',
  'merchant_cashback_config_history',
  'merchant_cashback_configs',
  'admin_idempotency_keys',
  'social_id_token_uses',
  'user_identities',
  'refresh_tokens',
  'otps',
  'users',
  'watcher_cursors',
] as const;

let migrationsApplied = false;

/**
 * Ensures the test DB schema is up-to-date. Idempotent — drizzle's
 * migrator no-ops once the journal is current. Call once per test
 * file (Vitest re-uses the worker process across tests in the same
 * file, so we only pay for this on cold start).
 */
export async function ensureMigrated(): Promise<void> {
  if (migrationsApplied) return;
  await migrate(db, { migrationsFolder: new URL('../../db/migrations', import.meta.url).pathname });
  migrationsApplied = true;
}

/**
 * Truncates every table touched by the integration suite. Run in
 * `beforeEach` so each test starts on a deterministic state. Uses a
 * single statement so postgres folds it into one txn and the
 * truncates land atomically.
 */
export async function truncateAllTables(): Promise<void> {
  const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`));
}
