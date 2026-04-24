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
import { db, closeDb } from '../db/client.js';
import { computeLedgerDriftSql } from '../credits/ledger-invariant.js';

async function main(): Promise<number> {
  const drift = await computeLedgerDriftSql(db, 1000);
  if (drift.length === 0) {
    console.log('OK: ledger invariant holds — no drift detected.');
    return 0;
  }
  console.log(`DRIFT: ${drift.length} (user, currency) pair(s) out of sync with ledger sum.`);
  for (const d of drift) {
    console.log(
      `  user=${d.userId} currency=${d.currency} balance=${d.balanceMinor} ledger=${d.ledgerSumMinor} delta=${d.deltaMinor}`,
    );
  }
  return 1;
}

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
