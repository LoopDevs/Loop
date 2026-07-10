/**
 * Real-postgres regression test for migration 0057 (R3-1 cold-start
 * cursor safety).
 *
 * WHY THIS EXISTS: `check:migration-parity` replays the migration
 * chain into an EMPTY database, so it structurally cannot catch a
 * migration that only fails when a pre-existing row is present. The
 * first draft of 0057 tried to defend its own backward-safety with
 *
 *     UPDATE operator_wallet_baselines SET active = 0
 *       WHERE (cursor IS NULL ...) AND active = 1;
 *     ALTER TABLE ... ALTER COLUMN starting_horizon_cursor SET NOT NULL;
 *
 * which does NOT work: `SET active = 0` never touches the cursor
 * column, and `ALTER COLUMN ... SET NOT NULL` validates the literal
 * value of EVERY row regardless of the active flag — so a lingering
 * NULL (active OR already-inactive) aborts the migration and BLOCKS
 * the deploy in exactly the scenario the defense exists for (a staging
 * raw-SQL row, a DR restore predating the Zod hardening, a future
 * non-API writer). The fix replaces the dead UPDATE with an
 * unconditional DELETE of the unsalvageable rows before the ALTERs.
 *
 * This test reconstructs the pre-0057 shape of the table (cursor
 * columns nullable, no length CHECK), seeds null-cursor rows (both an
 * `active=1` and an already-inactive one) alongside a valid row, then
 * applies the REAL 0057 migration SQL and asserts it SUCCEEDS, drops
 * the null rows, keeps the valid row, and leaves the NOT NULL + CHECK
 * constraints in force. Run this against the UPDATE-based draft and
 * the ALTER throws (proven empirically); against the DELETE fix it
 * passes.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres) — the same lane as the flywheel walk.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ensureMigrated } from './db-test-setup.js';

const MIGRATION_0057_PATH = new URL(
  '../../db/migrations/0057_operator_wallet_baselines_cursor_not_null.sql',
  import.meta.url,
).pathname;

/**
 * Drops the constraints migration 0057 adds so the table is back in
 * its pre-0057 shape: cursor columns nullable, no length CHECK. Lets
 * the test seed the exact rows that used to block the migration.
 */
async function revertToPre0057Shape(): Promise<void> {
  await db.execute(
    sql.raw(`
      ALTER TABLE operator_wallet_baselines
        DROP CONSTRAINT IF EXISTS operator_wallet_baselines_starting_cursor_len;
      ALTER TABLE operator_wallet_baselines
        DROP CONSTRAINT IF EXISTS operator_wallet_baselines_current_cursor_len;
      ALTER TABLE operator_wallet_baselines
        ALTER COLUMN starting_horizon_cursor DROP NOT NULL;
      ALTER TABLE operator_wallet_baselines
        ALTER COLUMN current_horizon_cursor DROP NOT NULL;
    `),
  );
}

async function clearBaselines(): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE operator_wallet_baselines, operator_wallet_movements,
        operator_manual_movements, operator_float_reconciliation_runs
        RESTART IDENTITY CASCADE`,
    ),
  );
}

async function applyMigration0057(): Promise<void> {
  const migrationSql = readFileSync(MIGRATION_0057_PATH, 'utf8');
  await db.execute(sql.raw(migrationSql));
}

// A syntactically-plausible 56-char G-address; the migration doesn't
// validate account shape, but keeping it realistic avoids surprises.
const ACCT = (fill: string): string => `G${fill.repeat(55)}`.slice(0, 56);

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await clearBaselines();
});

describe('migration 0057 — operator_wallet_baselines cursor NOT NULL, backward-safe DELETE', () => {
  it('applies over a pre-0057 table that contains null-cursor rows (active AND inactive) without aborting', async () => {
    await revertToPre0057Shape();

    // A valid, fully-anchored baseline that MUST survive.
    await db.execute(sql`
      INSERT INTO operator_wallet_baselines
        (asset, account, opening_balance_stroops, starting_horizon_cursor,
         current_horizon_cursor, active, reason, created_by)
      VALUES ('xlm', ${ACCT('A')}, 1000, 'cursor-anchor', 'cursor-anchor', 1,
              'valid anchored baseline', 'ops')
    `);
    // An ACTIVE row with a null starting cursor — the exact shape that
    // aborted the UPDATE-based draft's ALTER. Different account so the
    // one-active-per-(account,asset) unique index (0054) is satisfied.
    await db.execute(sql`
      INSERT INTO operator_wallet_baselines
        (asset, account, opening_balance_stroops, starting_horizon_cursor,
         current_horizon_cursor, active, reason, created_by)
      VALUES ('xlm', ${ACCT('B')}, 500, NULL, 'cursor-anchor', 1,
              'active null-starting-cursor row', 'legacy')
    `);
    // An ALREADY-INACTIVE row with a null current cursor — the case
    // the `AND active = 1` filter in the dead UPDATE skipped entirely,
    // yet SET NOT NULL still scans it.
    await db.execute(sql`
      INSERT INTO operator_wallet_baselines
        (asset, account, opening_balance_stroops, starting_horizon_cursor,
         current_horizon_cursor, active, reason, created_by)
      VALUES ('usdc', ${ACCT('C')}, 250, 'cursor-anchor', NULL, 0,
              'inactive null-current-cursor row', 'legacy')
    `);

    // The REAL migration SQL. With the UPDATE-based draft this throws
    // `column "starting_horizon_cursor" contains null values`; with the
    // DELETE fix it succeeds.
    await expect(applyMigration0057()).resolves.not.toThrow();

    const rows = (await db.execute(sql`
      SELECT account, active FROM operator_wallet_baselines ORDER BY account
    `)) as unknown as Array<{ account: string; active: number }>;
    const list = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;

    // Only the valid anchored row survives; both null-cursor rows are gone.
    expect(list).toHaveLength(1);
    expect(list[0]?.account).toBe(ACCT('A'));
    expect(list[0]?.active).toBe(1);
  });

  it('leaves NOT NULL + the length CHECK constraints in force after applying', async () => {
    await revertToPre0057Shape();
    await applyMigration0057();

    // NOT NULL back: a null cursor insert is rejected.
    await expect(
      db.execute(sql`
        INSERT INTO operator_wallet_baselines
          (asset, account, opening_balance_stroops, starting_horizon_cursor,
           current_horizon_cursor, active, reason, created_by)
        VALUES ('xlm', ${ACCT('D')}, 1, NULL, 'c', 1, 'null cursor', 'ops')
      `),
    ).rejects.toThrow();

    // CHECK back: an empty-string cursor is rejected (the "convention
    // tier promoted to DB tier" guarantee — a future non-API writer
    // can't slip an empty cursor past the >= 1 length check).
    await expect(
      db.execute(sql`
        INSERT INTO operator_wallet_baselines
          (asset, account, opening_balance_stroops, starting_horizon_cursor,
           current_horizon_cursor, active, reason, created_by)
        VALUES ('xlm', ${ACCT('E')}, 1, '', 'c', 1, 'empty cursor', 'ops')
      `),
    ).rejects.toThrow();

    // A fully-anchored non-empty baseline still inserts fine.
    await expect(
      db.execute(sql`
        INSERT INTO operator_wallet_baselines
          (asset, account, opening_balance_stroops, starting_horizon_cursor,
           current_horizon_cursor, active, reason, created_by)
        VALUES ('xlm', ${ACCT('F')}, 1, 'c0', 'c0', 1, 'valid', 'ops')
      `),
    ).resolves.not.toThrow();
  });
});
