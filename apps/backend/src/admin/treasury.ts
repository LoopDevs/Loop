/**
 * Admin treasury view (ADR 009/011/015).
 *
 * Aggregates the credit ledger into a single read-optimised snapshot
 * the admin UI can render without running its own aggregation SQL:
 *
 *   - outstanding[currency] — sum of `user_credits.balance_minor`
 *     per currency: "how much does Loop owe users right now?".
 *   - totals[currency][type] — sum of `credit_transactions.amount_minor`
 *     grouped by (currency, type): "cashback credited all-time" vs
 *     "withdrawals paid" vs "interest accrued" etc.
 *   - liabilities — ADR 015 labelling of `outstanding` on the Stellar
 *     side: per LOOP asset code, the amount outstanding + the
 *     configured issuer account. The admin UI renders this as the
 *     "Loop liabilities" card so ops can tell at a glance how many
 *     USDLOOP/GBPLOOP/EURLOOP Loop is on the hook for.
 *   - assets — Loop's own holdings split off from the liabilities
 *     pile (ADR 015 treasury strategy). Initial MVP surface covers
 *     USDC and XLM holdings — live Stellar-side balances land in a
 *     follow-up slice, so these are nullable placeholders today.
 *   - operatorPool — snapshot of per-operator circuit state for the
 *     CTX supplier pool (ADR 013).
 *
 * All fields return as strings for `bigint`-backed columns so the
 * JSON envelope is safe across JS platforms (no silent precision
 * truncation into a `number`).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type {
  LoopLiability,
  TreasuryHolding,
  TreasuryOrderFlow,
  TreasurySnapshot,
} from '@loop/shared';
import { db } from '../db/client.js';
import { userCredits, creditTransactions } from '../db/schema.js';
import { getOperatorHealth, operatorPoolSize } from '../ctx/operator-pool.js';
import {
  buildPayoutCounts,
  buildOrderFlows,
  buildAssets,
  buildLiabilities,
} from './treasury-builders.js';

// A2-1506: treasury shapes moved to `@loop/shared/admin-treasury.ts`
// so the openapi registration + web consumer compile against the same
// definition. Re-exported via `export type` so existing in-file and
// handler-side imports keep resolving.
export type { LoopLiability, TreasuryHolding, TreasuryOrderFlow, TreasurySnapshot };

/** GET /api/admin/treasury */
export async function treasuryHandler(c: Context): Promise<Response> {
  const outstandingRows = await db
    .select({
      currency: userCredits.currency,
      total: sql<string>`COALESCE(SUM(${userCredits.balanceMinor}), 0)::text`,
    })
    .from(userCredits)
    .groupBy(userCredits.currency);

  const totalsRows = await db
    .select({
      currency: creditTransactions.currency,
      type: creditTransactions.type,
      total: sql<string>`COALESCE(SUM(${creditTransactions.amountMinor}), 0)::text`,
    })
    .from(creditTransactions)
    .groupBy(creditTransactions.currency, creditTransactions.type);

  const outstanding: Record<string, string> = {};
  for (const row of outstandingRows) {
    outstanding[row.currency] = row.total;
  }

  const totals: Record<string, Record<string, string>> = {};
  for (const row of totalsRows) {
    let bucket = totals[row.currency];
    if (bucket === undefined) {
      bucket = {};
      totals[row.currency] = bucket;
    }
    bucket[row.type] = row.total;
  }

  const liabilities = buildLiabilities(outstanding);
  const assets = await buildAssets();
  const payouts = await buildPayoutCounts();
  const orderFlows = await buildOrderFlows();

  const snapshot: TreasurySnapshot = {
    outstanding,
    totals,
    liabilities,
    assets,
    payouts,
    orderFlows,
    operatorPool: {
      size: operatorPoolSize(),
      operators: getOperatorHealth(),
    },
  };

  return c.json(snapshot);
}

// `buildPayoutCounts`, `buildOrderFlows`, `buildAssets`, and
// `buildLiabilities` (the four section builders that compose
// the snapshot) live in `./treasury-builders.ts`. Imported at
// the top of this file for use in `treasuryHandler` above.
