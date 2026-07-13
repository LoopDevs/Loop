/**
 * Real-postgres completeness guard for `truncateAllTables()`.
 *
 * The integration harness isolates state by TRUNCATE-ing a curated
 * root set (`TABLES_TO_TRUNCATE`) with CASCADE, relying on foreign
 * keys to sweep the rest. That only works if EVERY base table is
 * either in the root set or reachable by CASCADE from it — any table
 * with no such FK path is never cleared and latent-leaks rows across
 * tests (TST-07: `ctx_catalog_snapshots`,
 * `operator_wallet_baselines`, `operator_float_reconciliation_runs`,
 * and `operator_manual_movements` were exactly this gap).
 *
 * This test re-derives coverage from the live schema: it computes the
 * CASCADE closure of the root set over the actual FK graph and asserts
 * it spans every `public` base table. If a future migration adds a
 * table with no FK path into the closure, this fails LOUDLY here
 * rather than silently corrupting some unrelated suite's fixtures.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ensureMigrated, truncateAllTables, TABLES_TO_TRUNCATE } from './db-test-setup.js';

beforeAll(async () => {
  await ensureMigrated();
});

/** Every `public` base table, minus drizzle's own migration bookkeeping. */
async function allBaseTables(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE 'drizzle%'
      AND table_name NOT LIKE '\\_\\_drizzle%'
  `)) as unknown as Array<{ table_name: string }>;
  return rows.map((r) => r.table_name);
}

/** FK edges as (child references parent) pairs, in `public`. */
async function fkEdges(): Promise<Array<{ child: string; parent: string }>> {
  const rows = (await db.execute(sql`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `)) as unknown as Array<{ child: string; parent: string }>;
  return rows.map((r) => ({ child: r.child, parent: r.parent }));
}

/**
 * Tables `TRUNCATE <roots> ... CASCADE` actually clears: the roots
 * plus every table that (transitively) references a cleared table.
 * CASCADE flows parent→child, so we grow the set toward children.
 * (TRUNCATE CASCADE truncates referencing rows regardless of each
 * FK's ON DELETE action, so SET NULL edges count here too.)
 */
function cascadeClosure(
  roots: readonly string[],
  edges: Array<{ child: string; parent: string }>,
): Set<string> {
  const covered = new Set<string>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { child, parent } of edges) {
      if (covered.has(parent) && !covered.has(child)) {
        covered.add(child);
        changed = true;
      }
    }
  }
  return covered;
}

describe('truncateAllTables coverage', () => {
  it('clears every base table (explicitly listed or reached by CASCADE)', async () => {
    const tables = await allBaseTables();
    const edges = await fkEdges();
    const covered = cascadeClosure(TABLES_TO_TRUNCATE, edges);

    const uncovered = tables.filter((t) => !covered.has(t)).sort();
    // A non-empty list means some table leaks state between tests.
    expect(uncovered).toEqual([]);
  });

  it('lists only real tables (no stale names in the root set)', async () => {
    const tables = new Set(await allBaseTables());
    const stale = TABLES_TO_TRUNCATE.filter((t) => !tables.has(t)).sort();
    expect(stale).toEqual([]);
  });

  it('executes cleanly — every listed name is a truncatable table', async () => {
    // Guards that the actual TRUNCATE statement (not just our closure
    // math) is valid against the live schema.
    await expect(truncateAllTables()).resolves.toBeUndefined();
  });

  it('actually empties the four previously-uncovered tables', async () => {
    // Seed one row in each table that had no CASCADE path (TST-07),
    // then prove the harness truncate now clears them. Uses only the
    // NOT NULL columns each table requires.
    await truncateAllTables();
    await db.execute(sql`
      INSERT INTO ctx_catalog_snapshots (name, payload, item_count, loaded_at)
      VALUES ('merchants', '[]'::jsonb, 0, now())
    `);
    await db.execute(sql`
      INSERT INTO operator_wallet_baselines
        (asset, account, opening_balance_stroops, starting_horizon_cursor,
         current_horizon_cursor, reason, created_by)
      VALUES ('usdc', 'GTESTACCOUNT', 0, 'cursor-0', 'cursor-0', 'seed', 'test-admin')
    `);
    await db.execute(sql`
      INSERT INTO operator_manual_movements
        (asset, account, direction, amount_stroops, reason, created_by)
      VALUES ('usdc', 'GTESTACCOUNT', 'in', 1, 'seed', 'test-admin')
    `);
    await db.execute(sql`
      INSERT INTO operator_float_reconciliation_runs
        (asset, account, threshold_stroops, state)
      VALUES ('usdc', 'GTESTACCOUNT', 0, 'ok')
    `);

    await truncateAllTables();

    for (const table of [
      'ctx_catalog_snapshots',
      'operator_wallet_baselines',
      'operator_manual_movements',
      'operator_float_reconciliation_runs',
    ]) {
      const rows = (await db.execute(
        sql.raw(`SELECT count(*)::int AS n FROM "${table}"`),
      )) as unknown as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(0);
    }
  });
});
