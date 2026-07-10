/**
 * Playwright globalSetup for the loop-native purchase-through-the-UI
 * e2e suite (Q6-4, docs/money-auth-worklist.md).
 *
 * Mirrors `../e2e-mocked/global-setup.ts` — runs the checked-in drizzle
 * migrations against `loop_test` BEFORE Playwright spins up the
 * backend (which skips its own `runMigrations()` under
 * `NODE_ENV=test`), then truncates every table so each invocation
 * starts clean. No seed rows: this suite drives EVERYTHING through the
 * UI — order creation, payment, procurement, fulfilment — rather than
 * pre-seeding a terminal state (that's what `tests/e2e-flywheel`'s
 * consumer-side walk does).
 *
 * Locally: requires `docker compose up -d db`. In CI, the
 * `test-e2e-flywheel` job's `postgres:16` service container is reused
 * (same 5433 → 5432 port mapping) — this suite runs as a second step
 * in that job, after `tests/e2e-flywheel` has already finished and
 * torn down its own webServer.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop_test';

const TABLES_TO_TRUNCATE = [
  'user_favorite_merchants',
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
