/**
 * Playwright globalSetup for the mocked-e2e suite (A2-1705 phase A.2).
 *
 * Runs the checked-in drizzle migrations against the `loop_test`
 * postgres BEFORE Playwright spins up the backend, so the backend
 * boots against a schema that's already current. Truncates every
 * table so each Playwright invocation starts on a clean state.
 *
 * The backend itself skips `runMigrations()` under `NODE_ENV=test`
 * (see `apps/backend/src/index.ts`), which is fine — this hook is
 * the one place migrations need to run for the mocked-e2e harness.
 *
 * Locally: requires `docker compose up -d db`. In CI, the
 * `test-e2e-mocked` job declares a `postgres:16` service container
 * with the same port mapping (5433 → 5432) so the URL is identical.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop_test';

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
];

export default async function globalSetup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, types: { bigint: postgres.BigInt } });
  const db = drizzle(client);
  try {
    await migrate(db, {
      migrationsFolder: new URL('../../apps/backend/src/db/migrations', import.meta.url).pathname,
    });
    const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
    await db.execute(sql.raw(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`));
  } finally {
    await client.end({ timeout: 5 });
  }
}
