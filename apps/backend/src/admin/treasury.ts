/**
 * Admin treasury view (ADR 009/011).
 *
 * Aggregates the credit ledger into a single read-optimised snapshot
 * the admin UI can render without running its own aggregation SQL:
 *
 *   - outstanding[currency] — sum of `user_credits.balance_minor`
 *     per currency: "how much does Loop owe users right now?".
 *   - totals[currency][type] — sum of `credit_transactions.amount_minor`
 *     grouped by (currency, type): "cashback credited all-time" vs
 *     "withdrawals paid" vs "interest accrued" etc.
 *   - operatorPool — snapshot of per-operator circuit state for the
 *     CTX supplier pool (ADR 013).
 *
 * All fields return as strings for `bigint`-backed columns so the
 * JSON envelope is safe across JS platforms (no silent precision
 * truncation into a `number`).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits, creditTransactions } from '../db/schema.js';
import { getOperatorHealth, operatorPoolSize } from '../ctx/operator-pool.js';

export interface TreasurySnapshot {
  outstanding: Record<string, string>;
  totals: Record<string, Record<string, string>>;
  operatorPool: {
    size: number;
    operators: Array<{ id: string; state: string }>;
  };
}

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

  const snapshot: TreasurySnapshot = {
    outstanding,
    totals,
    operatorPool: {
      size: operatorPoolSize(),
      operators: getOperatorHealth(),
    },
  };

  return c.json(snapshot);
}
