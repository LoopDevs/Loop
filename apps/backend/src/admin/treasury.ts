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
import { db } from '../db/client.js';
import { userCredits, creditTransactions, HOME_CURRENCIES } from '../db/schema.js';
import { getOperatorHealth, operatorPoolSize } from '../ctx/operator-pool.js';
import { payoutAssetFor, type LoopAssetCode } from '../credits/payout-asset.js';

export interface LoopLiability {
  /** Outstanding claim in the matching fiat's minor units (pence, cents). */
  outstandingMinor: string;
  /** Stellar issuer account pinned by env; null when the operator hasn't configured this asset yet. */
  issuer: string | null;
}

export interface TreasuryHolding {
  /**
   * Live on-chain balance in stroops (7 decimals), or null when Loop
   * doesn't query that asset today. A future slice queries Horizon
   * for the operator account's USDC + XLM balances.
   */
  stroops: string | null;
}

export interface TreasurySnapshot {
  outstanding: Record<string, string>;
  totals: Record<string, Record<string, string>>;
  /** ADR 015 — per LOOP asset, outstanding + configured issuer. */
  liabilities: Record<LoopAssetCode, LoopLiability>;
  /** ADR 015 — Loop's yield-earning pile (USDC + XLM operator holdings). */
  assets: {
    USDC: TreasuryHolding;
    XLM: TreasuryHolding;
  };
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

  const liabilities = buildLiabilities(outstanding);

  const snapshot: TreasurySnapshot = {
    outstanding,
    totals,
    liabilities,
    // Live Stellar-side holdings land in a follow-up slice once the
    // operator account(s) are configured + Horizon reads are wired.
    // Null today so the UI can render "—" rather than a misleading 0.
    assets: {
      USDC: { stroops: null },
      XLM: { stroops: null },
    },
    operatorPool: {
      size: operatorPoolSize(),
      operators: getOperatorHealth(),
    },
  };

  return c.json(snapshot);
}

/**
 * Re-frames `outstanding` as LOOP-asset liabilities: the currency
 * key is swapped for the matching LOOP asset code, and the issuer
 * is pinned alongside so the admin UI can flag "no issuer
 * configured" next to the number. Always returns entries for all
 * three assets so the UI shape is stable across deploys.
 */
function buildLiabilities(
  outstanding: Record<string, string>,
): Record<LoopAssetCode, LoopLiability> {
  // Keys are typed narrowly; the cast is safe because we construct
  // the whole record inside the same loop.
  const out = {} as Record<LoopAssetCode, LoopLiability>;
  for (const currency of HOME_CURRENCIES) {
    const { code, issuer } = payoutAssetFor(currency);
    out[code] = {
      outstandingMinor: outstanding[currency] ?? '0',
      issuer,
    };
  }
  return out;
}
