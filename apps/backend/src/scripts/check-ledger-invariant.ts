#!/usr/bin/env tsx
/**
 * Ledger invariant smoke (A2-1519).
 *
 * Connects to `DATABASE_URL`, runs the drift query from
 * `src/credits/ledger-invariant.ts::computeLedgerDriftSql`, prints a
 * one-line summary plus any drift rows, and exits non-zero when the
 * ledger has drifted.
 *
 * Intended as a post-deploy smoke and an on-demand operator tool —
 * not wired into the pre-merge CI pipeline because that pipeline has
 * no test Postgres (no drift to detect in an empty DB). The admin
 * `/api/admin/reconciliation` endpoint is the live ops surface; this
 * script is the shell-callable equivalent.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/scripts/check-ledger-invariant.ts
 *
 * Exit codes:
 *   0 — ledger consistent (drift array empty)
 *   1 — drift detected (details printed to stdout)
 *   2 — DB error (details printed to stderr)
 */
/* eslint-disable no-console */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb } from '../db/client.js';
import { computeLedgerDriftSql, type DriftEntry } from '../credits/ledger-invariant.js';

/**
 * DAT-09: how many drifted (user, currency) pairs we print in full. A
 * healthy ledger has ZERO drift, so any non-empty result is already an
 * incident; this cap only stops a pathological mass-drift from spewing
 * unbounded output. We deliberately fetch ONE row past this cap (see
 * `main`) so a truncated report can be flagged explicitly — the earlier
 * code fetched exactly `limit` rows and then printed `drift.length`,
 * which silently presented the cap (1000) as the true drift count when
 * the real drift was larger.
 */
const DISPLAY_LIMIT = 1000;

/**
 * Renders the operator report from a drift slice. Pure (no I/O) so the
 * truncation logic is unit-testable. `drift` is expected to hold up to
 * `displayLimit + 1` rows: seeing the extra row is how we know the
 * underlying query had more than `displayLimit` drifted pairs.
 */
export function formatDriftReport(
  drift: DriftEntry[],
  displayLimit: number,
): { code: 0 | 1; lines: string[] } {
  if (drift.length === 0) {
    return { code: 0, lines: ['OK: ledger invariant holds — no drift detected.'] };
  }
  const truncated = drift.length > displayLimit;
  const shown = truncated ? drift.slice(0, displayLimit) : drift;
  const count = truncated ? `more than ${displayLimit}` : String(drift.length);
  const lines = [`DRIFT: ${count} (user, currency) pair(s) out of sync with ledger sum.`];
  for (const d of shown) {
    lines.push(
      `  user=${d.userId} currency=${d.currency} balance=${d.balanceMinor} ledger=${d.ledgerSumMinor} delta=${d.deltaMinor}`,
    );
  }
  if (truncated) {
    lines.push(
      `  … output truncated: only the first ${displayLimit} drifted pair(s) are shown — the ` +
        `true count is higher. Query /api/admin/reconciliation for the complete set.`,
    );
  }
  return { code: 1, lines };
}

async function main(): Promise<number> {
  // Fetch one past DISPLAY_LIMIT so `formatDriftReport` can distinguish
  // "exactly N drifted pairs" from "≥ DISPLAY_LIMIT, report truncated".
  const drift = await computeLedgerDriftSql(db, DISPLAY_LIMIT + 1);
  const { code, lines } = formatDriftReport(drift, DISPLAY_LIMIT);
  for (const line of lines) console.log(line);
  return code;
}

// Only run the CLI when this module is the process entry point (`tsx
// src/scripts/check-ledger-invariant.ts`). Importing it — e.g. the unit
// test that exercises `formatDriftReport` directly — must NOT run
// `main()`, hit the DB, or `process.exit()`. Mirrors quarterly-tax.ts.
const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main()
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error('FAILED: ledger invariant check errored.');
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(2);
    });
}
